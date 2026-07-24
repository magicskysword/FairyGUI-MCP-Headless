export const PREVIEW_ORIGIN = "http://fairygui.internal";

export const PREVIEW_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light">
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; }
    body { position: relative; }
  </style>
</head>
<body>
  <script src="/runtime.js"></script>
  <script src="/preview.js"></script>
</body>
</html>`;

export const PREVIEW_SCRIPT = String.raw`
(() => {
  "use strict";

  const setStatus = (status, details) => {
    globalThis.__fairyguiPreview = { status, details };
    document.body.dataset.previewStatus = status;
  };

  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const waitForImages = async () => {
    const images = Array.from(document.images);
    await Promise.all(images.map(async (image) => {
      if (!image.complete) {
        await new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
      }
      if (typeof image.decode === "function") {
        await image.decode().catch(() => undefined);
      }
    }));
  };

  const fetchBytes = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        "Runtime artifact request failed: " + response.status + " " + url
      );
    }
    return response.arrayBuffer();
  };

  const loadPackages = async (descriptors) => {
    const loaded = [];
    for (const descriptor of descriptors) {
      const packageURL = new URL(descriptor.url, location.origin).href;
      const resourceBaseURL = new URL(
        "/assets/" + encodeURIComponent(descriptor.packageName) + "/",
        location.origin
      ).href;
      const pkg = fgui.UIPackage.loadPackageFromBuffer(
        await fetchBytes(packageURL),
        {
          source: packageURL,
          resourceBaseURL,
          resourceURLResolver:
            fgui.createUnityPackageResourceURLResolver()
        }
      );
      loaded.push(pkg);
    }
    await Promise.all(loaded.map((pkg) => pkg.waitForResources()));
    return loaded;
  };

  const start = async () => {
    if (!globalThis.fgui) {
      throw new Error("FairyGUI-dom runtime was not loaded");
    }

    const response = await fetch("/payload.json");
    if (!response.ok) {
      throw new Error("Preview payload could not be loaded");
    }
    const payload = await response.json();
    document.body.style.width = payload.viewport.width + "px";
    document.body.style.height = payload.viewport.height + "px";
    document.body.style.background = payload.background || "transparent";

    await loadPackages(payload.packages);
    const pkg = fgui.UIPackage.getById(payload.packageId);
    if (!pkg) {
      throw new Error("Target runtime package was not loaded: " + payload.packageId);
    }
    const item = pkg.getItemById(payload.componentId);
    if (!item) {
      throw new Error(
        "Target runtime component was not found: "
          + payload.packageId
          + "/"
          + payload.componentId
      );
    }
    const view = pkg.internalCreateObject(item);
    if (!(view instanceof fgui.GComponent)) {
      throw new Error(
        "Target runtime item is not a component: "
          + payload.packageId
          + "/"
          + payload.componentId
      );
    }

    const root = fgui.GRoot.inst;
    while (root.numChildren > 0) {
      root.removeChildAt(root.numChildren - 1, true);
    }
    root.setSize(payload.viewport.width, payload.viewport.height);
    view.setPosition(0, 0);
    view.setSize(payload.viewport.width, payload.viewport.height);
    view.element.dataset.fairyComponentRoot = "true";
    if (payload.background) {
      view.element.style.background = payload.background;
    }
    root.addChild(view);

    if (document.fonts) {
      await document.fonts.ready;
    }
    await waitForImages();
    await nextFrame();
    await nextFrame();

    const bounds = view.element.getBoundingClientRect();
    setStatus("ready", {
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      },
      packageCount: payload.packages.length
    });
  };

  setStatus("loading");
  start().catch((error) => {
    setStatus("failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  });
})();
`;
