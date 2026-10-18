import { expect, test } from "bun:test";
import { THEMES, themeVariables, themeById } from "../../src/web/themes.ts";
import { db, migrate } from "../../src/db/index.ts";
import { Router, type RouteContext } from "../../src/api/router.ts";
import { registerBackupRoutes } from "../../src/api/routes/backups.ts";

migrate();
function luminance(hex: string) {
  const values = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(x => x <= .04045 ? x/12.92 : ((x+.055)/1.055)**2.4);
  return values[0]!*.2126+values[1]!*.7152+values[2]!*.0722;
}
function contrast(a:string,b:string) { const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }

test("themes are unique, include at least five dark and five light, and have readable foregrounds", () => {
  expect(THEMES.filter(t=>t.mode==="dark").length).toBeGreaterThanOrEqual(5);
  expect(THEMES.filter(t=>t.mode==="light").length).toBeGreaterThanOrEqual(5);
  expect(new Set(THEMES.map(t=>t.id)).size).toBe(THEMES.length);
  expect(new Set(THEMES.map(t=>t.name)).size).toBe(THEMES.length);
  expect(themeById("black")?.colors[0]).toBe("#000000"); expect(themeById("invalid")).toBeUndefined();
  for(const theme of THEMES) {
    const vars=themeVariables(theme.id);
    for(const bg of ["--bg","--bg-elevated","--bg-inset"]) for(const text of ["--text","--text-dim","--text-faint"]) expect(contrast(vars[bg]!,vars[text]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars["--accent"]!,vars["--button-text"]!)).toBeGreaterThanOrEqual(4.5);
  }
});

test("an administrator can select every registered theme, including the newest ones", async () => {
  const old=db.query("SELECT theme FROM instance_appearance WHERE id=1").get() as {theme:string}|null;
  const router=new Router(); registerBackupRoutes(router);
  const call=(auth:unknown,theme:unknown,method="PUT")=>{
    const request=new Request(`http://localhost${method==="GET"?"/api/appearance":"/api/admin/appearance"}`,{method,...(method==="GET"?{}:{headers:{"content-type":"application/json"},body:JSON.stringify({theme})})});
    return router.match(method,new URL(request.url).pathname)!.handler({request,url:new URL(request.url),auth,params:{},ip:"127.0.0.1"} as RouteContext);
  };
  const admin={kind:"user",userId:1,username:"admin",isAdmin:true,via:"session",scopes:["admin"]};
  try {
    for(const auth of [{kind:"anonymous"},{...admin,isAdmin:false},{...admin,via:"token"}]) await expect(Promise.resolve().then(()=>call(auth,"black"))).rejects.toThrow();
    await expect(call(admin,"url(javascript:bad)")).rejects.toThrow();
    for(const theme of THEMES) { expect(await (await call(admin,theme.id)).json()).toEqual({theme:theme.id}); expect(await (await call({kind:"anonymous"},null,"GET")).json()).toEqual({theme:theme.id}); }
  } finally { db.query("DELETE FROM instance_appearance WHERE id=1").run();if(old)db.query("INSERT INTO instance_appearance(id,theme) VALUES(1,?)").run(old.theme); }
});


test("every palette defines dynamic interaction and syntax colors without inheriting another theme", () => {
  const required = ["--link","--link-hover","--accent-hover","--hover-bg","--focus-ring","--checker-tile","--selection-bg","--syntax-comment","--syntax-string","--syntax-number","--syntax-keyword","--syntax-type","--syntax-function","--syntax-tag","--syntax-attr","--shadow-sm","--shadow-md","--shadow-lg"];
  for (const theme of THEMES) {
    const vars = themeVariables(theme.id);
    for (const name of required) expect(vars[name]).toBeTruthy();
    expect(vars["--link"]).toBe(theme.colors[8]);
    expect(vars["--link-hover"]).toContain(theme.colors[8]);
    expect(vars["--hover-bg"]).toContain(theme.colors[6]);
    expect(vars["--btn-bg"]).toContain(theme.colors[1]);
    expect(contrast(vars["--btn-primary-bg"]!, vars["--btn-primary-text"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars["--btn-primary-hover-bg"]!, vars["--btn-primary-text"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars["--btn-danger-hover-bg"]!, vars["--btn-danger-hover-text"]!)).toBeGreaterThanOrEqual(4.5);
    expect(vars["--accent-hover"]).not.toBe(vars["--accent"]);
  }
});
