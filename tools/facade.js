/* A PIXI that is only what the page asks of it, recorded. Both page
   harnesses (page_harness.js, pixi_check.js) boot the page's engine
   against this facade headlessly; every node write is counted, every
   texture and render tracked. It records the page's engine as a
   browser would run it — the "no performance tuning" property
   (bounded writes, no mid-frame captures) is asserted against it. */
"use strict";

function makeFacade(rec) {
  class PixiNode {
    constructor() {
      this.children = [];
      this._ = { alpha: 1, tint: 0xffffff, x: 0, y: 0, sx: 1, sy: 1,
                 rot: 0, texture: null, width: 0, height: 0 };
      this.anchor = { set(x2, y2) { rec.anchorSets++; } };
    }
    addChild(...cs) {
      for (const c of cs) this.children.push(c);
      return cs[0];
    }
    removeChildren() { const c = this.children; this.children = []; return c; }
    w() { rec.writes++; }
    get alpha() { return this._.alpha; }
    set alpha(v) { this._.alpha = v; this.w(); }
    get tint() { return this._.tint; }
    set tint(v) { this._.tint = v; this.w(); }
    get texture() { return this._.texture; }
    set texture(v) { this._.texture = v; this.w(); }
    get width() { return this._.width; }
    set width(v) { this._.width = v; this.w(); }
    get height() { return this._.height; }
    set height(v) { this._.height = v; this.w(); }
    get scale() {
      const self = this;
      return { get x() { return self._.sx; },
               set x(v) { self._.sx = v; self.w(); },
               get y() { return self._.sy; },
               set y(v) { self._.sy = v; self.w(); },
               set(x, y) { self._.sx = x; self._.sy = y; self.w(); } };
    }
    get position() {
      const self = this;
      return { get x() { return self._.x; },
               set x(v) { self._.x = v; self.w(); },
               get y() { return self._.y; },
               set y(v) { self._.y = v; self.w(); },
               set(x, y) { self._.x = x; self._.y = y; self.w(); } };
    }
    get rotation() { return this._.rot; }
    set rotation(v) { this._.rot = v; this.w(); }
  }

  const Application = class {
    constructor() {
      this.stage = new PixiNode();
      this.canvas = { id: "facade-canvas", style: {}, listeners: {},
                      addEventListener(ev, fn) {
                        (this.listeners[ev] = this.listeners[ev] || [])
                            .push(fn); },
                      getBoundingClientRect: () =>
                        ({ left: 0, top: 0, width: 528, height: 528 }) };
      this.renderer = {
        maxTextureSize: rec.maxTextureSize || 4096,
        resize(w, h, res) { rec.resizes.push([Math.round(w),
                                              Math.round(h), res]); },
      };
    }
    async init(opts) {
      rec.inits++;
      if (rec.failInit) throw new Error("no surface for the engine");
      rec.initOpts = opts;
    }
    render() { rec.renders++; }
  };

  return {
    Application,
    Container: PixiNode,
    Sprite: class extends PixiNode { constructor(tex) { super();
        if (tex !== undefined) this.texture = tex; } },
    Text: class extends PixiNode {
      constructor(str, style) { super(); this.text = str;
        this.style = style; } },
    Graphics: class extends PixiNode {
      constructor() { super(); this.paths = 0; }
      clear() { this.paths = 0; return this; }
      ellipse() { this.paths++; return this; }
      circle() { this.paths++; return this; }
      rect() { this.paths++; return this; }
      moveTo() { return this; }
      lineTo() { return this; }
      closePath() { return this; }
      beginPath() { return this; }
      fill(o) { return this; }
      stroke(o) { return this; }
    },
    FillGradient: class { constructor(opts) { this.opts = opts; }
                          addColorStop() {} },
    Texture: { from(src) {
      rec.textures++;
      return { source: { update() { rec.updates++; } },
               destroy(recursive) { rec.destroys++; },
               __src: src, width: src && src.width || 0,
               height: src && src.height || 0 };
    } },
  };
}

module.exports = { makeFacade };