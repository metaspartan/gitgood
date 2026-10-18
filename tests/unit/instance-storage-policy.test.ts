import { expect, test } from "bun:test";
import { db, migrate } from "../../src/db/index.ts";
import { repositoryDefaultQuota, setRepositoryDefaultQuota } from "../../src/data/instance-settings.ts";
import { effectiveQuotaBytes, type RepoRecord } from "../../src/data/repos.ts";
import { registerBackupRoutes } from "../../src/api/routes/backups.ts";
import { Router, type RouteContext } from "../../src/api/router.ts";

migrate();
test("admin policy applies immediately to inherited quotas without changing explicit limits", () => {
  const old = db.query("SELECT value FROM instance_settings WHERE key='default_repo_quota_bytes'").get() as {value:number}|null;
  try {
    for (const limit of [0, 1, 1024 ** 5]) {
      setRepositoryDefaultQuota(limit);
      expect(repositoryDefaultQuota()).toEqual({bytes:limit,source:"admin"});
      expect(effectiveQuotaBytes({quota_bytes:null} as RepoRecord)).toBe(limit || Infinity);
      expect(effectiveQuotaBytes({quota_bytes:77} as RepoRecord)).toBe(77);
      expect(effectiveQuotaBytes({quota_bytes:0} as RepoRecord)).toBe(Infinity);
    }
    for (const limit of [-1, 0.5, 1024 ** 5 + 1, NaN]) expect(() => setRepositoryDefaultQuota(limit)).toThrow();
  } finally {
    db.query("DELETE FROM instance_settings WHERE key='default_repo_quota_bytes'").run();
    if (old) setRepositoryDefaultQuota(old.value);
  }
});
test("storage policy API rejects anonymous, ordinary users and admin tokens", async () => {
  const router = new Router(); registerBackupRoutes(router);
  for (const method of ["GET", "PUT"]) for (const auth of [{kind:"anonymous"}, {kind:"user",userId:1,username:"user",isAdmin:false,via:"session",scopes:["write"]}, {kind:"user",userId:1,username:"admin",isAdmin:true,via:"token",scopes:["admin"]}]) {
    const request = new Request("http://localhost/api/admin/storage-policy",{method});
    await expect(Promise.resolve().then(()=>router.match(method,"/api/admin/storage-policy")!.handler({request,url:new URL(request.url),params:{},ip:"127.0.0.1",auth} as RouteContext))).rejects.toThrow();
  }
});
test("API validates before writing and returns persisted value", async () => {
  const old = repositoryDefaultQuota();
  const router = new Router(); registerBackupRoutes(router);
  const call = (value: unknown) => {
    const request = new Request("http://localhost/api/admin/storage-policy",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({default_repo_quota_bytes:value})});
    return router.match("PUT","/api/admin/storage-policy")!.handler({request,url:new URL(request.url),params:{},ip:"127.0.0.1",auth:{kind:"user",userId:1,username:"admin",isAdmin:true,via:"session",scopes:["admin"]}});
  };
  try {
    for (const value of [-1, "10GB", null, 1.5, 1024 ** 5 + 1]) await expect(call(value)).rejects.toThrow();
    const result = await call(0); expect(await result.json()).toEqual({bytes:0,source:"admin"});
  } finally { db.query("DELETE FROM instance_settings WHERE key='default_repo_quota_bytes'").run(); if(old.source==="admin")setRepositoryDefaultQuota(old.bytes); }
});
