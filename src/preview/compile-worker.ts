import path from "node:path";
import { ProjectSnapshot, buildPreviewArtifacts } from "@magicskysword/openfairygui-functions";
import { loadSharpRasterBackend } from "@magicskysword/openfairygui-functions/node";

process.once("message", async (input: { projectPath: string; files: Array<{ path: string; data: Uint8Array }> }) => {
  try {
    const files = new Map(input.files.map(file => [file.path, file.data]));
    const snapshot = await ProjectSnapshot.fromFiles(input.projectPath, files, new Map(), new Map(), { join: path.join, dirname: path.dirname });
    const encoder = await loadSharpRasterBackend();
    if (!encoder) throw new Error("Sharp raster backend is unavailable");
    const result = await buildPreviewArtifacts(snapshot, { encoder });
    process.send?.({ result }, () => process.disconnect());
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.disconnect()); }
});
