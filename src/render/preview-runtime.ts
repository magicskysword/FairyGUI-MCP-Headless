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

  const asColor = (value, fallback) => {
    try {
      return fgui.Color.fromHexString(value || fallback);
    }
    catch {
      return fgui.Color.fromHexString(fallback);
    }
  };

  const applyCommon = (object, node) => {
    const style = node.style || {};
    object.name = node.name || "";
    object.setPosition(style.left || 0, style.top || 0);
    object.setSize(
      style.width === undefined ? (node.type === "group" ? 0 : 120) : style.width,
      style.height === undefined ? (node.type === "group" ? 0 : 32) : style.height
    );
    object.minWidth = style.minWidth || 0;
    object.maxWidth = style.maxWidth || 0;
    object.minHeight = style.minHeight || 0;
    object.maxHeight = style.maxHeight || 0;
    object.alpha = style.opacity === undefined ? 1 : style.opacity;
    object.rotation = style.rotation || 0;
    object.setScale(
      style.scaleX === undefined ? 1 : style.scaleX,
      style.scaleY === undefined ? 1 : style.scaleY
    );
    object.skewX = style.skewX || 0;
    object.skewY = style.skewY || 0;
    object.setPivot(
      style.pivotX || 0,
      style.pivotY || 0,
      style.pivotAsAnchor === true
    );
    object.visible = style.visible !== false;
    object.touchable = style.touchable !== false;
    object.grayed = style.grayed === true;
    object.element.dataset.fairyNodeId = node.id;
    object.element.dataset.fairyNodeType = node.type;
    return object;
  };

  const createText = (node, textOverride) => {
    const object = new fgui.GTextField();
    object.autoSize = fgui.AutoSizeType.None;
    const content = node.content || {};
    const format = object.textFormat;
    format.size = content.fontSize || 14;
    format.color = asColor(content.color, "#1f2937").getHex();
    format.align = content.align || "left";
    format.verticalAlign = content.verticalAlign || "top";
    format.bold = content.bold === true;
    format.italic = content.italic === true;
    format.underline = content.underline === true;
    format.strikethrough = content.strikethrough === true;
    format.lineSpacing = content.lineSpacing || 0;
    format.letterSpacing = content.letterSpacing || 0;
    object.singleLine = content.singleLine === true;
    if (node.type === "rich-text")
      object.ubbEnabled = content.ubb === true;
    applyCommon(object, node);
    object.applyFormat();
    object.text = textOverride === undefined ? (content.text || "") : textOverride;
    return object;
  };

  const drawBox = (object, fill, line, lineSize) => {
    const graph = new fgui.GGraph();
    graph.setSize(object.width, object.height);
    graph.element.drawRect(
      lineSize === undefined ? 1 : lineSize,
      asColor(line, "#64748b"),
      asColor(fill, "#e2e8f0")
    );
    object.addChild(graph);
  };

  const addPlaceholderLabel = (object, text) => {
    const label = new fgui.GTextField();
    label.autoSize = fgui.AutoSizeType.None;
    label.setPosition(6, 5);
    label.setSize(Math.max(0, object.width - 12), Math.max(0, object.height - 10));
    label.textFormat.size = 12;
    label.textFormat.color = asColor("#334155", "#334155").getHex();
    label.applyFormat();
    label.text = text;
    object.addChild(label);
  };

  const createPlaceholder = (node, fill, label) => {
    const object = applyCommon(new fgui.GComponent(), node);
    drawBox(object, fill, "#64748b", 1);
    addPlaceholderLabel(object, label);
    return object;
  };

  const createGraph = (node) => {
    const object = applyCommon(new fgui.GGraph(), node);
    const content = node.content || {};
    const lineSize = content.lineSize || 0;
    const lineColor = asColor(content.lineColor, "#00000000");
    const fillColor = asColor(content.fillColor, "#00000000");
    if (content.shape === "ellipse") {
      object.element.drawEllipse(lineSize, lineColor, fillColor, 0, 360);
    }
    else if (content.shape === "rectangle") {
      const radius = content.cornerRadius;
      if (radius && radius.some((value) => value > 0)) {
        object.element.drawRoundRect(
          lineSize,
          lineColor,
          fillColor,
          radius[0],
          radius[1],
          radius[2],
          radius[3]
        );
      }
      else {
        object.element.drawRect(lineSize, lineColor, fillColor);
      }
    }
    else if (content.shape !== "empty") {
      object.element.drawRect(lineSize, lineColor, fillColor);
      object.element.dataset.structuralShapeFallback = content.shape;
    }
    return object;
  };

  const createList = (node) => {
    const object = createPlaceholder(node, "#f8fafc", "List · " + node.content.layout);
    const items = node.content.items || [];
    const horizontal =
      node.content.layout === "single-row" ||
      node.content.layout === "flow-horizontal" ||
      node.content.layout === "pagination";
    const gap = horizontal
      ? (node.content.columnGap || 4)
      : (node.content.lineGap || 4);
    let offset = 24;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const label = new fgui.GTextField();
      label.autoSize = fgui.AutoSizeType.None;
      if (horizontal)
        label.setPosition(offset, 24);
      else
        label.setPosition(6, offset);
      label.setSize(horizontal ? 72 : Math.max(0, object.width - 12), 22);
      label.textFormat.size = 11;
      label.textFormat.color = asColor("#475569", "#475569").getHex();
      label.applyFormat();
      label.text = item.title || item.name || ("Item " + (index + 1));
      object.addChild(label);
      offset += (horizontal ? 72 : 22) + gap;
    }
    return object;
  };

  const createNode = (node) => {
    switch (node.type) {
      case "text":
      case "rich-text":
      case "input-text":
        return createText(node);
      case "graph":
        return createGraph(node);
      case "group": {
        const group = applyCommon(new fgui.GGroup(), node);
        group.layout = {
          none: fgui.GroupLayoutType.None,
          horizontal: fgui.GroupLayoutType.Horizontal,
          vertical: fgui.GroupLayoutType.Vertical
        }[node.content.layout];
        group.lineGap = node.content.lineGap || 0;
        group.columnGap = node.content.columnGap || 0;
        group.excludeInvisibles = node.content.excludeInvisibles === true;
        group.autoSizeDisabled = node.content.autoSizeDisabled === true;
        return group;
      }
      case "list":
      case "tree":
        return createList(node);
      case "image":
        return createPlaceholder(node, node.content.color || "#dbeafe", "Image");
      case "loader":
        return createPlaceholder(
          node,
          "#ede9fe",
          node.content.externalUrl ? "Loader · external blocked" : "Loader"
        );
      case "loader3d":
        return createPlaceholder(node, "#fae8ff", "Loader3D · read-only");
      case "movie-clip":
        return createPlaceholder(node, "#ffedd5", "Movie Clip");
      case "instance":
        return createPlaceholder(
          node,
          "#dcfce7",
          "Instance · " + node.content.resource.resourceId
        );
      default:
        return createPlaceholder(node, "#fee2e2", "Unsupported · " + node.type);
    }
  };

  const start = async () => {
    if (!globalThis.fgui)
      throw new Error("FairyGUI-dom runtime was not loaded");

    const response = await fetch("/payload.json");
    if (!response.ok)
      throw new Error("Preview payload could not be loaded");
    const payload = await response.json();
    const dom = payload.dom;
    const root = fgui.GRoot.inst;
    while (root.numChildren > 0)
      root.removeChildAt(root.numChildren - 1, true);

    document.body.style.width = payload.viewport.width + "px";
    document.body.style.height = payload.viewport.height + "px";
    document.body.style.background = payload.background || "transparent";

    const view = new fgui.GComponent();
    view.name = dom.root.name;
    view.setPosition(0, 0);
    view.setSize(payload.viewport.width, payload.viewport.height);
    view.element.dataset.fairyComponentRoot = "true";
    view.element.style.boxSizing = "border-box";
    view.element.style.overflow = dom.root.content.overflow === "visible"
      ? "visible"
      : (dom.root.content.overflow === "scroll" ? "auto" : "hidden");
    const componentBackground =
      payload.background || dom.root.content.backgroundColor;
    if (componentBackground)
      view.element.style.background = componentBackground;

    const objects = new Map();
    for (const node of dom.root.children) {
      const object = createNode(node);
      objects.set(node.id, object);
      view.addChild(object);
    }

    for (const node of dom.root.children) {
      const object = objects.get(node.id);
      if (node.groupId && objects.get(node.groupId) instanceof fgui.GGroup)
        object.group = objects.get(node.groupId);
      for (const relation of node.relations || []) {
        const target = relation.targetId === dom.root.id
          ? view
          : objects.get(relation.targetId);
        const relationType = fgui.RelationType[relation.type];
        if (target && relationType !== undefined)
          object.addRelation(target, relationType, relation.percent === true);
      }
    }

    root.addChild(view);
    if (document.fonts)
      await document.fonts.ready;
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
      nodeCount: dom.root.children.length
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
