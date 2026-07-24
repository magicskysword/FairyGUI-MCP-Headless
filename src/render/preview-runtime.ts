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

  const resolveTreeNode = (tree, nodePath, path) => {
    let parent = tree.rootNode;
    for (let depth = 0; depth < nodePath.length; depth++) {
      const childIndex = nodePath[depth];
      if (childIndex < 0 || childIndex >= parent.numChildren) {
        stateFailure({
          code: "TRANSIENT_STATE_INVALID",
          message: "Tree 节点路径超出当前父节点的子节点范围",
          path: path + "[" + depth + "]",
          actual: childIndex,
          allowed: {
            min: 0,
            max: parent.numChildren - 1,
            childCount: parent.numChildren
          }
        });
      }
      parent = parent.getChildAt(childIndex);
    }
    return parent;
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

  const targetDetails = (object, root) => ({
    id: object === root ? "component-root" : object.id || "",
    name: object.name || "",
    type: runtimeType(object, root)
  });

  const selectedControllerPage = (controller) => ({
    index: controller.selectedIndex,
    id: controller.selectedIndex < 0 ? null : controller.selectedPageId,
    name: controller.selectedIndex < 0 ? null : controller.selectedPage
  });

  const applyTransientState = (view, state) => {
    const applied = {
      controllers: [],
      lists: [],
      trees: [],
      scrolls: []
    };
    if (!state) return applied;
    (state.controllers || []).forEach((entry, stateIndex) => {
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
        applied.controllers.push({
          selector: entry.selector.source,
          target: targetDetails(target, view),
          controller: entry.controller,
          selectedPage: selectedControllerPage(controller)
        });
      });
    });

    (state.trees || []).forEach((entry, stateIndex) => {
      const path = "state.trees[" + stateIndex + "]";
      const targets = matchObjects(view, entry.selector);
      if (targets.length !== entry.expectedMatches) {
        stateFailure({
          code: "SELECTOR_MATCH_COUNT",
          message:
            "临时 Tree 选择器匹配数量不符合 expectedMatches："
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
          typeof fgui.GTree !== "function"
          || !(target instanceof fgui.GTree)
        ) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "Tree 临时状态只能应用到 GTree 节点",
            path: path + ".selector",
            actual: {
              selector: entry.selector.source,
              targetId: target.id || "",
              targetName: target.name || "",
              targetType: runtimeType(target, view)
            },
            allowed: ["tree"]
          });
        }

        entry.expansions.forEach((expansion, expansionIndex) => {
          const nodePath = path
            + ".expansions["
            + expansionIndex
            + "].path";
          const node = resolveTreeNode(target, expansion.path, nodePath);
          if (!node.isFolder) {
            stateFailure({
              code: "TRANSIENT_STATE_INVALID",
              message: "Tree 叶节点没有可设置的展开状态",
              path: nodePath,
              actual: expansion.path,
              allowed: ["指向 folder 节点的 nodePath"]
            });
          }
          node.expanded = expansion.expanded;
        });

        if (entry.selectedPath === null) {
          target.clearSelection();
        }
        else if (entry.selectedPath !== undefined) {
          const node = resolveTreeNode(
            target,
            entry.selectedPath,
            path + ".selectedPath"
          );
          target.clearSelection();
          target.selectNode(node, false);
          if (target.getSelectedNode() !== node) {
            stateFailure({
              code: "TRANSIENT_STATE_INVALID",
              message: "Tree 节点未形成请求的运行时选中状态",
              path: path + ".selectedPath",
              actual: target.getSelectedNode() ? "different-node" : null,
              allowed: {
                requested: entry.selectedPath,
                requirement:
                  "Tree selectionMode 必须允许选择且节点项目必须是 Button"
              }
            });
          }
        }
        applied.trees.push({
          selector: entry.selector.source,
          target: targetDetails(target, view),
          expansions: entry.expansions.map((item) => ({
            path: item.path,
            expanded: item.expanded
          })),
          ...(entry.selectedPath === undefined
            ? {}
            : { selectedPath: entry.selectedPath })
        });
      });
    });

    (state.lists || []).forEach((entry, stateIndex) => {
      const path = "state.lists[" + stateIndex + "]";
      const targets = matchObjects(view, entry.selector);
      if (targets.length !== entry.expectedMatches) {
        stateFailure({
          code: "SELECTOR_MATCH_COUNT",
          message:
            "临时列表选择器匹配数量不符合 expectedMatches："
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
          typeof fgui.GList !== "function"
          || !(target instanceof fgui.GList)
          || typeof fgui.GTree === "function" && target instanceof fgui.GTree
        ) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "列表临时选择只能应用到非 Tree 的 GList 节点",
            path: path + ".selector",
            actual: {
              selector: entry.selector.source,
              targetId: target.id || "",
              targetName: target.name || "",
              targetType: runtimeType(target, view)
            },
            allowed: ["list"]
          });
        }

        const indices = entry.selectedIndices;
        for (let index = 0; index < indices.length; index++) {
          const selectedIndex = indices[index];
          if (selectedIndex < 0 || selectedIndex >= target.numItems) {
            stateFailure({
              code: "TRANSIENT_STATE_INVALID",
              message: "列表临时选择索引超出项目范围",
            path: path + ".selectedIndices[" + index + "]",
              actual: selectedIndex,
              allowed: {
                min: -1,
                max: target.numItems - 1,
                itemCount: target.numItems
              }
            });
          }
        }
        if (indices.length > 0 && target.selectionMode === 3) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "目标列表的 selectionMode 为 none，不能设置选中项",
            path: path + ".selector",
            actual: "none",
            allowed: ["single", "multiple", "multipleSingleClick"]
          });
        }
        if (indices.length > 1 && target.selectionMode === 0) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "单选列表不能设置多个临时选中项",
            path: path + ".selectedIndices",
            actual: indices,
            allowed: { maxSelections: 1 }
          });
        }

        target.clearSelection();
        indices.forEach((selectedIndex) => {
          target.addSelection(selectedIndex, false);
        });
        const actualSelection = target.getSelection([]).sort((a, b) => a - b);
        const expectedSelection = [...indices].sort((a, b) => a - b);
        if (
          actualSelection.length !== expectedSelection.length
          || actualSelection.some(
            (selectedIndex, index) =>
              selectedIndex !== expectedSelection[index]
          )
        ) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "列表项目未形成请求的运行时选中状态",
            path: path,
            actual: actualSelection,
            allowed: {
              requested: expectedSelection,
              requirement: "列表项目必须是可选中的 Button"
            }
            });
        }
        applied.lists.push({
          selector: entry.selector.source,
          target: targetDetails(target, view),
          selectedIndices: actualSelection
        });
      });
    });

    (state.scrolls || []).forEach((entry, stateIndex) => {
      const path = "state.scrolls[" + stateIndex + "]";
      const targets = matchObjects(view, entry.selector);
      if (targets.length !== entry.expectedMatches) {
        stateFailure({
          code: "SELECTOR_MATCH_COUNT",
          message:
            "临时滚动选择器匹配数量不符合 expectedMatches："
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
          || !target.scrollPane
        ) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "临时滚动只能应用到启用了 overflow=scroll 的组件",
            path: path + ".selector",
            actual: {
              selector: entry.selector.source,
              targetId: target.id || "",
              targetName: target.name || "",
              targetType: runtimeType(target, view)
            },
            allowed: [
              "启用了 overflow=scroll 的 component-root、instance、list 或 tree"
            ]
          });
        }

        target.ensureBoundsCorrect();
        const scrollPane = target.scrollPane;
        const maxX = Math.max(0, scrollPane.contentWidth - scrollPane.viewWidth);
        const maxY = Math.max(0, scrollPane.contentHeight - scrollPane.viewHeight);
        if (entry.position.x !== undefined && entry.position.x > maxX) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "临时横向滚动位置超出实际可滚范围",
            path: path + ".position.x",
            actual: entry.position.x,
            allowed: { min: 0, max: maxX }
          });
        }
        if (entry.position.y !== undefined && entry.position.y > maxY) {
          stateFailure({
            code: "TRANSIENT_STATE_INVALID",
            message: "临时纵向滚动位置超出实际可滚范围",
            path: path + ".position.y",
            actual: entry.position.y,
            allowed: { min: 0, max: maxY }
          });
        }
        if (entry.position.x !== undefined) {
          scrollPane.setPosX(entry.position.x, false);
        }
        if (entry.position.y !== undefined) {
          scrollPane.setPosY(entry.position.y, false);
        }
        applied.scrolls.push({
          selector: entry.selector.source,
          target: targetDetails(target, view),
          position: {
            x: scrollPane.posX,
            y: scrollPane.posY
          }
        });
      });
    });
    return applied;
  };

  const treeNodeDetails = (tree) => {
    const nodes = [];
    const visit = (parent, parentPath) => {
      for (let index = 0; index < parent.numChildren; index++) {
        const node = parent.getChildAt(index);
        const path = parentPath.concat(index);
        nodes.push({
          path,
          text: node.text || "",
          isFolder: Boolean(node.isFolder),
          expanded: Boolean(node.expanded)
        });
        visit(node, path);
      }
    };
    visit(tree.rootNode, []);
    return nodes;
  };

  const treeNodePath = (tree, target) => {
    if (!target) return null;
    let found = null;
    const visit = (parent, parentPath) => {
      for (let index = 0; index < parent.numChildren; index++) {
        const node = parent.getChildAt(index);
        const path = parentPath.concat(index);
        if (node === target) {
          found = path;
          return true;
        }
        if (visit(node, path)) return true;
      }
      return false;
    };
    visit(tree.rootNode, []);
    return found;
  };

  const inspectAvailableState = (view, detail) => {
    const entries = runtimeEntries(view);
    const controllers = entries
      .filter((entry) =>
        Array.isArray(entry.object.controllers)
        && entry.object.controllers.length > 0
      )
      .map((entry) => ({
        target: targetDetails(entry.object, view),
        controllers: entry.object.controllers.map((controller) => ({
          name: controller.name || "",
          selectedPage: selectedControllerPage(controller),
          pages: controllerDetails(controller).indices.map((index) => ({
            index,
            id: controller.getPageId(index) || "",
            name: controller.getPageName(index) || ""
          }))
        }))
      }));
    const lists = entries
      .filter((entry) =>
        typeof fgui.GList === "function"
        && entry.object instanceof fgui.GList
        && (
          typeof fgui.GTree !== "function"
          || !(entry.object instanceof fgui.GTree)
        )
      )
      .map((entry) => ({
        target: targetDetails(entry.object, view),
        itemCount: entry.object.numItems,
        selectionMode: [
          "single",
          "multiple",
          "multipleSingleClick",
          "none"
        ][entry.object.selectionMode] || String(entry.object.selectionMode),
        selectedIndices: entry.object.getSelection([]).sort((a, b) => a - b)
      }));
    const trees = entries
      .filter((entry) =>
        typeof fgui.GTree === "function"
        && entry.object instanceof fgui.GTree
      )
      .map((entry) => {
        const nodes = treeNodeDetails(entry.object);
        return {
          target: targetDetails(entry.object, view),
          nodeCount: nodes.length,
          folderCount: nodes.filter((node) => node.isFolder).length,
          selectedPath: treeNodePath(
            entry.object,
            entry.object.getSelectedNode()
          ),
          ...(detail === "full" ? { nodes } : {})
        };
      });
    const scrolls = entries
      .filter((entry) =>
        typeof fgui.GComponent === "function"
        && entry.object instanceof fgui.GComponent
        && entry.object.scrollPane
      )
      .map((entry) => {
        const scrollPane = entry.object.scrollPane;
        entry.object.ensureBoundsCorrect();
        return {
          target: targetDetails(entry.object, view),
          position: {
            x: scrollPane.posX,
            y: scrollPane.posY
          },
          maxPosition: {
            x: Math.max(0, scrollPane.contentWidth - scrollPane.viewWidth),
            y: Math.max(0, scrollPane.contentHeight - scrollPane.viewHeight)
          }
        };
      });
    return { controllers, lists, trees, scrolls };
  };

  const inspectGearHidden = (view, detail) => {
    const hidden = runtimeEntries(view)
      .filter((entry) => {
        const gears = entry.object._gears;
        return entry.object !== view
          && entry.object.visible
          && !entry.object.internalVisible
          && Array.isArray(gears)
          && (gears[0] || gears[8]);
      })
      .map((entry) => targetDetails(entry.object, view));
    const nodes = detail === "full" ? hidden : hidden.slice(0, 20);
    return {
      count: hidden.length,
      nodes,
      truncated: nodes.length < hidden.length
    };
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

    // GRoot creates Stage and installs FairyGUI-dom's measurement CSS.
    // It must exist before component construction, otherwise auto-size text
    // is measured as an unstyled inline span and reports a zero logical size.
    const root = fgui.GRoot.inst;
    while (root.numChildren > 0) {
      root.removeChildAt(root.numChildren - 1, true);
    }
    root.setSize(payload.viewport.width, payload.viewport.height);

    const view = pkg.internalCreateObject(item);
    if (!(view instanceof fgui.GComponent)) {
      throw new Error(
        "Target runtime item is not a component: "
          + payload.packageId
          + "/"
          + payload.componentId
      );
    }

    view.setPosition(0, 0);
    view.setSize(payload.viewport.width, payload.viewport.height);
    view.element.dataset.fairyComponentRoot = "true";
    if (payload.background) {
      view.element.style.background = payload.background;
    }
    root.addChild(view);
    const appliedState = applyTransientState(view, payload.state);

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
      packageCount: payload.packages.length,
      availableState: inspectAvailableState(view, payload.stateDetail),
      appliedState,
      gearHidden: inspectGearHidden(view, payload.stateDetail)
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
