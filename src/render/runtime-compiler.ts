import { readFile } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@magicskysword/openfairygui-core/node";
import { publishToMemory } from "@magicskysword/openfairygui-functions";
import { loadSharpRasterBackend } from "@magicskysword/openfairygui-functions/node";

export interface RuntimePackageArtifact {
  packageId: string;
  packageName: string;
  fileName: string;
}

export interface RuntimeArtifact {
  fileName: string;
  mediaType: string;
  data: Uint8Array;
}

export interface CompiledRuntimeArtifacts {
  packages: RuntimePackageArtifact[];
  artifacts: RuntimeArtifact[];
}

function mediaType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".json":
      return "application/json";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

export async function compileRuntimeArtifacts(
  projectFile: string,
  projectDirectory: string
): Promise<CompiledRuntimeArtifacts> {
  const document = await new NodeIO().readProject(projectFile);
  const sourcePackages = document.getRoot().listPackages();
  // 预览编译使用独立模型；临时导出全部组件，避免把 Editor 发布范围
  // 错当成“是否允许预览”，且绝不把该状态写回工程。
  for (const pkg of sourcePackages) {
    for (const component of pkg.listComponents()) {
      component.setExported(true);
    }
  }
  const settings = document.getRoot().getSettings();
  document.getRoot().setSettings({
    ...settings,
    publish: {
      ...settings.publish,
      includeHighResolution: 7
    }
  });
  const packages = sourcePackages.map((pkg) => ({
    packageId: pkg.getId(),
    packageName: pkg.getName(),
    fileName: `${pkg.getPublishName() || pkg.getName()}.fui`
  }));
  const encoder = await loadSharpRasterBackend();
  if (!encoder) {
    throw new Error("Sharp raster backend is unavailable.");
  }
  const artifacts = await publishToMemory(document, {
    encoder,
    basePath: path.join(projectDirectory, "assets"),
    fileExtension: "fui",
    atlas: {
      readFileRaw: async (filePath) => {
        const data = await readFile(filePath);
        return new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.byteLength
        );
      }
    }
  });
  const artifactNames = new Set(artifacts.map((artifact) => artifact.fileName));
  for (const pkg of packages) {
    if (!artifactNames.has(pkg.fileName)) {
      throw new Error(
        `运行时包未生成：${pkg.packageId}/${pkg.packageName} (${pkg.fileName})`
      );
    }
  }

  return {
    packages,
    artifacts: artifacts.map((artifact) => ({
      fileName: artifact.fileName,
      mediaType: mediaType(artifact.fileName),
      data: artifact.data
    }))
  };
}
