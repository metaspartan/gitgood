import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "gitgood-test-"));

process.env.NODE_ENV = "test";
process.env.GITGOOD_DATA_DIR = root;
process.env.GITGOOD_DB_PATH = join(root, "test.db");
process.env.GITGOOD_REPO_ROOT = join(root, "repositories");
process.env.GITGOOD_LFS_ROOT = join(root, "lfs");
process.env.GITGOOD_BASE_URL = "http://127.0.0.1:0";
process.env.GITGOOD_LOG_LEVEL = "error";
process.env.GITGOOD_RATE_MAX = "100000";
process.env.GITGOOD_AUTH_RATE_MAX = "100000";

process.env.GITGOOD_WEB_DIST = join(root, "no-prebuilt-web-dist");
