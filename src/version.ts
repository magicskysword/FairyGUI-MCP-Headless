import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAIRY_DOM_SCHEMA_VERSION } from "./contracts/dom.js";

export const PACKAGE_NAME = "@magicskysword/fairygui-mcp-headless";
export const PACKAGE_VERSION = "0.1.4";
export const SERVER_NAME = "fairygui-mcp-headless";

const RUNTIME_PACKAGES = [
  "@magicskysword/openfairygui-core",
  "@magicskysword/openfairygui-functions",
  "@magicskysword/fairygui-dom"
] as const;

function installedPackageVersion(packageName: string): string {
  let directory = path.dirname(fileURLToPath(import.meta.resolve(packageName)));
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        manifest.name === packageName
        && typeof manifest.version === "string"
        && manifest.version.length > 0
      ) {
        return manifest.version;
      }
    }
    catch {
      // 依赖入口通常位于 dist；继续向包根目录查找 package.json。
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`无法读取运行时依赖版本：${packageName}`);
    }
    directory = parent;
  }
}

export interface ProjectServiceInfo {
  packageName: typeof PACKAGE_NAME;
  version: typeof PACKAGE_VERSION;
  domSchemaVersion: typeof FAIRY_DOM_SCHEMA_VERSION;
  runtimeVersions: Record<typeof RUNTIME_PACKAGES[number], string>;
}

export const PROJECT_SERVICE_INFO: ProjectServiceInfo = Object.freeze({
  packageName: PACKAGE_NAME,
  version: PACKAGE_VERSION,
  domSchemaVersion: FAIRY_DOM_SCHEMA_VERSION,
  runtimeVersions: Object.freeze(Object.fromEntries(
    RUNTIME_PACKAGES.map((packageName) => [
      packageName,
      installedPackageVersion(packageName)
    ])
  )) as Record<typeof RUNTIME_PACKAGES[number], string>
});
