export const RUNTIME_PREVIEW_SCRIPT = String.raw`
(() => {
  "use strict";
  const fgui = globalThis.fgui;
  const clock = fgui.RuntimeClock;
  const nativeNow = performance.now.bind(performance);
  const nativeSetTimeout = setTimeout.bind(globalThis);
  const NativeDate = Date;
  let root, recipe, context, inspector, timeline = [], cursor = 0, realtimeStart = 0;
  let logs = [], currentPath = "initialize", failed;
  const now = () => recipe.environment.clock === "manual" ? clock.now() : nativeNow() - realtimeStart;
  const log = (level, values) => {
    if (logs.length >= 1000) logs.shift();
    logs.push({ level, message: values.map(value => {
      try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); }
    }).join(" ").slice(0, 4096), time: now() });
  };
  const safeKey = key => /^[A-Za-z][A-Za-z0-9]*$/.test(key) && !["constructor", "prototype"].includes(key);
  const assign = (object, props) => {
    for (const [key, value] of Object.entries(props)) {
      if (!safeKey(key) || !(key in object)) throw new Error("Unknown runtime property: " + key);
      object[key] = value;
    }
  };
  const one = selector => {
    const objects = inspector.query(root, selector || ":root");
    if (objects.length !== 1) throw new Error("Runtime selector must match one object: " + selector + " (" + objects.length + ")");
    return objects[0];
  };
  const script = (code, path) => {
    const fn = new Function("ctx", "fgui", '"use strict";\n' + code + '\n//# sourceURL=preview/' + path.replace(/[^A-Za-z0-9_.\[\]-]/g, "_") + '.js');
    return fn(context, fgui);
  };
  const operation = (item, path) => {
    currentPath = path;
    if (item.op === "script") return script(item.code, path);
    const object = one(item.target);
    if (item.op === "set") assign(object, item.props);
    else if (item.op === "controller") {
      const controller = object.getController(item.name);
      if (!controller) throw new Error("Controller not found: " + item.name);
      if (item.pageId !== undefined) {
        if (controller.getPageIndexById(item.pageId) < 0) throw new Error("Controller page ID not found");
        controller.selectedPageId = item.pageId;
      } else if (item.pageName !== undefined) {
        if (!controller.hasPage(item.pageName)) throw new Error("Controller page name not found");
        controller.selectedPage = item.pageName;
      } else if (item.index !== undefined && item.index < controller.pageCount) controller.selectedIndex = item.index;
      else throw new Error("Controller selection is invalid");
    } else if (item.op === "call") {
      if (!safeKey(item.method) || typeof object[item.method] !== "function") throw new Error("Runtime method not found: " + item.method);
      return object[item.method](...item.args);
    } else if (item.op === "event") object.emit(item.type, item.data);
    else if (item.op === "scroll") {
      if (!object.scrollPane) throw new Error("Target does not have a ScrollPane");
      if (item.x !== undefined) object.scrollPane.setPosX(item.x, item.animated);
      if (item.y !== undefined) object.scrollPane.setPosY(item.y, item.animated);
    } else if (item.op === "list") {
      if (!(object instanceof fgui.GList)) throw new Error("Target is not a GList");
      if (item.defaultItem) object.defaultItem = item.defaultItem;
      object.itemRenderer = (index, cell) => assign(cell, item.items[index]);
      object.numItems = item.items.length;
    } else if (item.op === "tree") {
      if (!(object instanceof fgui.GTree)) throw new Error("Target is not a GTree");
      object.rootNode.removeChildren();
      object.treeNodeRender = (node, cell) => { if (node.data && node.data.props) assign(cell, node.data.props); };
      const add = (parent, values, depth) => {
        if (depth > 64) throw new Error("Tree depth exceeded");
        for (const value of values) {
          const node = new fgui.GTreeNode(!!value.children, value.url);
          node.data = value; parent.addChild(node);
          if (value.children) add(node, value.children, depth + 1);
          node.expanded = !!value.expanded;
        }
      };
      add(object.rootNode, item.items, 0);
    } else if (item.op === "transition") {
      const transition = object.getTransition(item.name);
      if (!transition) throw new Error("Transition not found: " + item.name);
      if (item.action === "pause" || item.action === "resume") transition.setPaused(item.action === "pause");
      else if (item.action === "stop") transition.stop();
      else transition[item.action](undefined, item.times);
    }
  };
  const appendTimeline = (entries, prefix) => {
    const addition = entries.map((entry, index) => ({ ...entry, path: prefix + "[" + index + "]", order: timeline.length + index }));
    if (prefix !== "timeline" && addition.some(entry => entry.at < now() - 1e-8)) throw new Error("Timeline events cannot precede the current simulation time");
    timeline = [...timeline.slice(cursor), ...addition].sort((a, b) => a.at - b.at || a.order - b.order);
    cursor = 0;
  };
  const due = time => {
    while (cursor < timeline.length && timeline[cursor].at <= time + 1e-8) {
      const entry = timeline[cursor++];
      for (let i = 0; i < entry.operations.length; i++) {
        const result = operation(entry.operations[i], entry.path + ".operations[" + i + "]");
        if (result && typeof result.then === "function") throw new Error("Timeline callbacks must finish synchronously; schedule later work through ctx.clock");
      }
    }
  };
  const state = options => ({ time: now(), frame: recipe.environment.clock === "manual" ? clock.frameCount : Math.floor(now() * 60 / 1000), nodes: inspector.inspect(root, options || {}), logs: logs.slice() });
  const errorInfo = error => ({ code: "PREVIEW_SCRIPT_FAILED", message: String(error.message || error), path: currentPath, stack: error.stack, time: now() });
  const waitImages = async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(async image => {
      if (!image.complete) await new Promise(resolve => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); });
      if (image.decode) await image.decode().catch(() => undefined);
    }));
  };
  globalThis.__fguiPreview = {
    async initialize(payload) {
      recipe = payload.recipe;
      inspector = new fgui.RuntimeInspector(payload.previewId);
      clock.useManual(60);
      let seed = recipe.environment.seed >>> 0;
      Math.random = () => { seed += 0x6D2B79F5; let v = seed; v = Math.imul(v ^ v >>> 15, v | 1); v ^= v + Math.imul(v ^ v >>> 7, v | 61); return ((v ^ v >>> 14) >>> 0) / 4294967296; };
      context = { data: structuredClone(recipe.data), fgui, root: undefined,
        query: selector => inspector.query(root, selector), one, ref: object => inspector.reference(object), resolve: ref => inspector.resolve(ref),
        clock: Object.freeze({ now, setTimeout: (fn, delay) => clock.setTimeout(fn, delay), setInterval: (fn, delay) => clock.setInterval(fn, delay), clear: id => clock.clearTimer(id), requestFrame: fn => clock.requestFrame(fn), cancelFrame: id => clock.cancelFrame(id) }),
        resources: Object.freeze({ url: name => { if (!payload.resourceNames.includes(name)) throw new Error("Resource mapping not found: " + name); return "/resources/" + encodeURIComponent(name); } }),
        log: (...values) => log("info", values), warn: (...values) => log("warning", values)
      };
      document.body.style.width = recipe.environment.width + "px";
      document.body.style.height = recipe.environment.height + "px";
      document.body.style.background = recipe.environment.background;
      for (const descriptor of payload.packages) {
        const url = "/assets/" + encodeURIComponent(descriptor.fileName);
        const response = await fetch(url);
        if (!response.ok) throw new Error("Runtime package fetch failed: " + url);
        const pkg = fgui.UIPackage.loadPackageFromBuffer(await response.arrayBuffer(), { source: location.origin + url, resourceBaseURL: location.origin + "/assets/", resourceURLResolver: fgui.createUnityPackageResourceURLResolver() });
        await pkg.waitForResources();
      }
      const readyRoot = fgui.GRoot.inst;
      readyRoot.setSize(recipe.environment.width, recipe.environment.height);
      function PreviewDate(...args) { return new.target ? Reflect.construct(NativeDate, args.length ? args : [now()], new.target) : new NativeDate(now()).toString(); }
      Object.setPrototypeOf(PreviewDate, NativeDate);
      PreviewDate.prototype = NativeDate.prototype;
      PreviewDate.now = now;
      globalThis.Date = PreviewDate;
      Object.defineProperty(performance, "now", { value: now });
      globalThis.setTimeout = (fn, delay = 0, ...args) => clock.setTimeout(() => fn(...args), delay);
      globalThis.setInterval = (fn, delay = 0, ...args) => clock.setInterval(() => fn(...args), delay);
      globalThis.clearTimeout = globalThis.clearInterval = id => clock.clearTimer(id);
      globalThis.requestAnimationFrame = fn => clock.requestFrame(fn);
      globalThis.cancelAnimationFrame = id => clock.cancelFrame(id);
      for (const level of ["log", "info", "warn", "error"]) console[level] = (...values) => log(level, values);
      if (recipe.preconstruct) await script(recipe.preconstruct, "preconstruct");
      const pkg = fgui.UIPackage.getById(payload.packageId);
      const item = pkg && pkg.getItemById(payload.componentId);
      if (!item) throw new Error("Runtime component not found");
      root = pkg.internalCreateObject(item);
      if (!(root instanceof fgui.GComponent)) throw new Error("Runtime source is not a component");
      context.root = root;
      readyRoot.addChild(root);
      for (let i = 0; i < recipe.setup.length; i++) await operation(recipe.setup[i], "setup[" + i + "]");
      clock.flushLayout();
      await waitImages();
      realtimeStart = nativeNow();
      if (recipe.environment.clock === "realtime") {
        // Automatic runtime frames retain the native browser scheduler.
        globalThis.requestAnimationFrame = window.__previewNativeRAF;
        globalThis.cancelAnimationFrame = window.__previewNativeCancelRAF;
        clock.useAutomatic();
      }
      appendTimeline(recipe.timeline, "timeline");
      due(0); clock.flushLayout();
      return state();
    },
    async runStart(input) {
      if (failed) throw new Error("Preview is failed; reset it before continuing");
      appendTimeline(input.timeline, "run.timeline");
      for (let i = 0; i < input.operations.length; i++) await operation(input.operations[i], "run.operations[" + i + "]");
      due(now()); clock.flushLayout();
    },
    async advance(time, options) {
      if (recipe.environment.clock === "manual") { due(clock.now()); clock.advanceTo(time, due); }
      else {
        while (now() < time) { due(now()); await new Promise(resolve => nativeSetTimeout(resolve, Math.min(1000 / 60, time - now()))); }
        due(now());
      }
      clock.flushLayout(); await waitImages();
      return state(options);
    },
    inspect(options) { clock.flushLayout(); return state(options); },
    failure(error) { failed = error; return errorInfo(error); }
  };
  window.__previewNativeRAF = window.requestAnimationFrame.bind(window);
  window.__previewNativeCancelRAF = window.cancelAnimationFrame.bind(window);
})();
`;
