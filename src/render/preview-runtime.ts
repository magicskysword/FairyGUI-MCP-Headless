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

  const runtimeType = (object, root) => {
    if (object === root) return "component-root";
    const is = (name) =>
      typeof fgui[name] === "function" && object instanceof fgui[name];
    if (is("GTree")) return "tree";
    if (is("GList")) return "list";
    if (is("GImage")) return "image";
    if (is("GRichTextField")) return "rich-text";
    if (is("GTextInput")) return "input-text";
    if (is("GTextField")) return "text";
    if (is("GLoader3D")) return "loader3d";
    if (is("GLoader")) return "loader";
    if (is("GGraph")) return "graph";
    if (is("GMovieClip")) return "movie-clip";
    if (is("GGroup")) return "group";
    if (is("GComponent")) return "instance";
    return "instance";
  };

  const runtimeEntries = (root) => {
    const entries = [];
    const visit = (object, parent) => {
      const entry = {
        object,
        parent,
        node: {
          type: runtimeType(object, root),
          id: object.id || "",
          name: object.name || ""
        }
      };
      entries.push(entry);
      if (
        typeof fgui.GComponent === "function"
        && object instanceof fgui.GComponent
      ) {
        for (let index = 0; index < object.numChildren; index++) {
          visit(object.getChildAt(index), entry);
        }
      }
    };
    visit(root, undefined);
    return entries;
  };

  const matchesCompound = (node, compound) =>
    (compound.type === undefined || node.type === compound.type)
    && (compound.id === undefined || node.id === compound.id)
    && (compound.name === undefined || node.name === compound.name);

  const matchesStep = (entry, steps, stepIndex) => {
    const step = steps[stepIndex];
    if (!step || !matchesCompound(entry.node, step.compound)) return false;
    if (stepIndex === 0) return true;
    if (step.combinator === "child") {
      return entry.parent !== undefined
        && matchesStep(entry.parent, steps, stepIndex - 1);
    }
    if (step.combinator === "descendant") {
      let ancestor = entry.parent;
      while (ancestor) {
        if (matchesStep(ancestor, steps, stepIndex - 1)) return true;
        ancestor = ancestor.parent;
      }
    }
    return false;
  };

  const matchObjects = (root, selector) => {
    const lastStep = selector.steps.length - 1;
    return runtimeEntries(root)
      .filter((entry) => matchesStep(entry, selector.steps, lastStep))
      .map((entry) => entry.object);
  };

  const stateFailure = (failure) => {
    const error = new Error(failure.message);
    error.previewFailure = failure;
    throw error;
  };

  const controllerDetails = (controller) => {
    const pageIds = [];
    const pageNames = [];
    for (let index = 0; index < controller.pageCount; index++) {
      pageIds.push(controller.getPageId(index));
      pageNames.push(controller.getPageName(index));
    }
    return {
      indices: pageIds.map((_, index) => index),
      pageIds,
      pageNames
    };
  };

  const applyTransientState = (view, state) => {
    if (!state) return;
    state.controllers.forEach((entry, stateIndex) => {
      const path = "state.controllers[" + stateIndex + "]";
      const targets = matchObjects(view, entry.selector);
      if (targets.length !== entry.expectedMatches) {
        stateFailure({
          code: "SELECTOR_MATCH_COUNT",
          message:
            "临时状态选择器匹配数量不符合 expectedMatches："
            + entry.selector.source,
          path: path + ".selector",
          actual: {
            selector: entry.selector.source,
            expectedMatches: entry.expectedMatches,
            actualMatches: targets.length
          },
          suggestedFix:
            "先用 fairygui.query 确认节点 ID/名称，并更新 expectedMatches"
        });
      }

      targets.forEach((target) => {
        if (
          typeof fgui.GComponent !== "function"
          || !(target instanceof fgui.GComponent)
        ) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "控制器临时状态只能应用到组件节点",
            path: path + ".selector",
            actual: {
              selector: entry.selector.source,
              targetId: target.id || "",
              targetName: target.name || "",
              targetType: runtimeType(target, view)
            },
            allowed: ["component-root", "instance"]
          });
        }

        const controller = target.getController(entry.controller);
        if (!controller) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "目标组件不存在控制器：" + entry.controller,
            path: path + ".controller",
            actual: entry.controller,
            allowed: target.controllers.map((item) => item.name)
          });
        }

        const allowed = controllerDetails(controller);
        let selectedIndex = -1;
        if (entry.selection.kind === "index") {
          selectedIndex = entry.selection.value;
        }
        else if (entry.selection.kind === "pageId") {
          selectedIndex = controller.getPageIndexById(entry.selection.value);
        }
        else {
          for (let index = 0; index < controller.pageCount; index++) {
            if (controller.getPageName(index) === entry.selection.value) {
              selectedIndex = index;
              break;
            }
          }
        }
        if (selectedIndex < 0 || selectedIndex >= controller.pageCount) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "控制器临时页不存在或超出范围",
            path: path,
            actual: entry.selection,
            allowed
          });
        }
        controller.setSelectedIndex(selectedIndex);
      });
    });
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
    applyTransientState(view, payload.state);

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
      stack: error instanceof Error ? error.stack : undefined,
      failure: error && error.previewFailure
        ? error.previewFailure
        : undefined
    });
  });
})();
`;
