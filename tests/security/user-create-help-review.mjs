// Validate the private help build without copying it into the served dashboard.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLinks } from "../../help-center/scripts/check-links.mjs";
import { prepare } from "../../help-center/scripts/prepare.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "help-center/dist");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function pagesIn(directory) {
  const pages = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) pages.push(...(await pagesIn(path)));
    else if (path.endsWith(".html")) pages.push(path);
  }
  return pages;
}
const prepared = await prepare();
const pages = await pagesIn(output);
await checkLinks(
  output,
  pages,
  resolve(root, "dashboard/src"),
  prepared.markdown,
);
const admin = await readFile(resolve(output, "administer/index.html"));
const troubleshooting = await readFile(
  resolve(output, "troubleshooting/index.html"),
);
if (!admin.toString().includes("account-creation-is-not-confirmed"))
  throw Error("Administer guide does not link to account creation recovery");
if (
  !troubleshooting.toString().includes('id="account-creation-is-not-confirmed"')
)
  throw Error("Account creation recovery anchor was not rendered");
const report = {
  passed: true,
  classification: "private_static_help_build",
  pages: pages.length,
  admin_sha256: hash(admin),
  troubleshooting_sha256: hash(troubleshooting),
  scope:
    "Prepared and built help-center/dist only; dashboard/dist and the live preview were not modified.",
};
await writeFile(
  resolve(root, "docs/evidence/user-create-help.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `PASS ${pages.length} private help pages and account-creation anchor`,
);
