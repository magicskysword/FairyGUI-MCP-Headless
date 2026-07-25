import { z } from "zod";

export const FAIRY_DOM_SCHEMA_VERSION = 1 as const;

export const FAIRYGUI_RELATION_TYPES = [
  "Left_Left",
  "Left_Center",
  "Left_Right",
  "Center_Center",
  "Right_Left",
  "Right_Center",
  "Right_Right",
  "Top_Top",
  "Top_Middle",
  "Top_Bottom",
  "Middle_Middle",
  "Bottom_Top",
  "Bottom_Middle",
  "Bottom_Bottom",
  "Width",
  "Height",
  "LeftExt_Left",
  "LeftExt_Right",
  "RightExt_Left",
  "RightExt_Right",
  "TopExt_Top",
  "TopExt_Bottom",
  "BottomExt_Top",
  "BottomExt_Bottom",
  "Size"
] as const;

export const FairyDomRelationTypeSchema = z.enum(FAIRYGUI_RELATION_TYPES);
export type FairyDomRelationType = z.infer<typeof FairyDomRelationTypeSchema>;

export const FairyDomRelationSchema = z.object({
  targetId: z.string().min(1),
  type: FairyDomRelationTypeSchema,
  percent: z.boolean().default(false)
}).strict();
export type FairyDomRelation = z.infer<typeof FairyDomRelationSchema>;

export const FairyDomStyleSchema = z.object({
  left: z.number().finite().optional(),
  top: z.number().finite().optional(),
  width: z.number().finite().nonnegative().optional(),
  height: z.number().finite().nonnegative().optional(),
  minWidth: z.number().finite().nonnegative().optional(),
  maxWidth: z.number().finite().nonnegative().optional(),
  minHeight: z.number().finite().nonnegative().optional(),
  maxHeight: z.number().finite().nonnegative().optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  rotation: z.number().finite().optional(),
  scaleX: z.number().finite().optional(),
  scaleY: z.number().finite().optional(),
  skewX: z.number().finite().optional(),
  skewY: z.number().finite().optional(),
  pivotX: z.number().finite().optional(),
  pivotY: z.number().finite().optional(),
  pivotAsAnchor: z.boolean().optional(),
  visible: z.boolean().optional(),
  touchable: z.boolean().optional(),
  grayed: z.boolean().optional()
}).strict();
export type FairyDomStyle = z.infer<typeof FairyDomStyleSchema>;

export const FairyDomResourceReferenceSchema = z.object({
  packageId: z.string().min(1),
  resourceId: z.string().min(1)
}).strict();
export type FairyDomResourceReference = z.infer<
  typeof FairyDomResourceReferenceSchema
>;

const nodeBaseShape = {
  id: z.string().min(1),
  name: z.string(),
  groupId: z.string().min(1).optional(),
  style: FairyDomStyleSchema,
  relations: z.array(FairyDomRelationSchema)
} as const;

const alignSchema = z.enum(["left", "center", "right"]);
const verticalAlignSchema = z.enum(["top", "middle", "bottom"]);
const textAutoSizeSchema = z.enum(["none", "both", "height", "shrink"]);
export const FairyDomFillMethodSchema = z.enum([
  "none",
  "horizontal",
  "vertical",
  "radial-90",
  "radial-180",
  "radial-360"
]);
export type FairyDomFillMethod = z.infer<typeof FairyDomFillMethodSchema>;
export const FairyDomFillOriginSchema = z.enum([
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right"
]);
export type FairyDomFillOrigin = z.infer<typeof FairyDomFillOriginSchema>;

const imageFillShape = {
  fillMethod: FairyDomFillMethodSchema.optional(),
  fillOrigin: FairyDomFillOriginSchema.optional(),
  fillClockwise: z.boolean().optional(),
  fillAmount: z.number().finite().min(0).max(1).optional()
} as const;

const textContentShape = {
  text: z.string(),
  font: FairyDomResourceReferenceSchema.optional(),
  fontSize: z.number().finite().positive().optional(),
  color: z.string().min(1).optional(),
  align: alignSchema.optional(),
  verticalAlign: verticalAlignSchema.optional(),
  autoSize: textAutoSizeSchema.optional(),
  singleLine: z.boolean().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  lineSpacing: z.number().finite().optional(),
  letterSpacing: z.number().finite().optional()
} as const;

export const FairyDomImageNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("image"),
  content: z.object({
    resource: FairyDomResourceReferenceSchema.optional(),
    flip: z.enum(["none", "horizontal", "vertical", "both"]).optional(),
    ...imageFillShape,
    color: z.string().min(1).optional()
  }).strict()
}).strict();

export const FairyDomTextNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("text"),
  content: z.object(textContentShape).strict()
}).strict();

export const FairyDomRichTextNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("rich-text"),
  content: z.object({
    ...textContentShape,
    ubb: z.boolean().optional()
  }).strict()
}).strict();

export const FairyDomInputTextNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("input-text"),
  content: z.object({
    ...textContentShape,
    prompt: z.string().optional(),
    restrict: z.string().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    password: z.boolean().optional(),
    keyboardType: z.enum([
      "default",
      "number",
      "url",
      "email",
      "phone"
    ]).optional()
  }).strict()
}).strict();

export const FairyDomLoaderNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("loader"),
  content: z.object({
    resource: FairyDomResourceReferenceSchema.optional(),
    externalUrl: z.string().min(1).optional(),
    fill: z.enum([
      "none",
      "scale",
      "scale-match-height",
      "scale-match-width",
      "scale-free",
      "scale-no-border"
    ]).optional(),
    align: alignSchema.optional(),
    verticalAlign: verticalAlignSchema.optional(),
    autoSize: z.boolean().optional(),
    playing: z.boolean().optional(),
    frame: z.number().int().nonnegative().optional(),
    ...imageFillShape
  }).strict()
}).strict();

export const FairyDomGraphNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("graph"),
  content: z.object({
    shape: z.enum(["empty", "rectangle", "ellipse", "polygon", "regular-polygon"]),
    fillColor: z.string().min(1).optional(),
    lineColor: z.string().min(1).optional(),
    lineSize: z.number().finite().nonnegative().optional(),
    cornerRadius: z.tuple([
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative(),
      z.number().finite().nonnegative()
    ]).optional(),
    sides: z.number().int().min(3).optional(),
    points: z.array(z.object({
      x: z.number().finite(),
      y: z.number().finite()
    }).strict()).optional()
  }).strict()
}).strict();

export const FairyDomMovieClipNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("movie-clip"),
  content: z.object({
    resource: FairyDomResourceReferenceSchema.optional(),
    playing: z.boolean().optional(),
    frame: z.number().int().nonnegative().optional(),
    color: z.string().min(1).optional()
  }).strict()
}).strict();

export const FairyDomGroupNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("group"),
  content: z.object({
    layout: z.enum(["none", "horizontal", "vertical"]),
    lineGap: z.number().finite().optional(),
    columnGap: z.number().finite().optional(),
    excludeInvisibles: z.boolean().optional(),
    autoSizeDisabled: z.boolean().optional(),
    mainGridIndex: z.number().int().min(-1).optional(),
    mainGridMinSize: z.number().finite().nonnegative().optional()
  }).strict()
}).strict();

export const FairyDomListItemSchema = z.object({
  name: z.string().optional(),
  title: z.string().optional(),
  selectedTitle: z.string().optional(),
  icon: FairyDomResourceReferenceSchema.optional(),
  selectedIcon: FairyDomResourceReferenceSchema.optional(),
  resource: FairyDomResourceReferenceSchema.optional()
}).strict();
export type FairyDomListItem = z.infer<typeof FairyDomListItemSchema>;

export const FairyDomListNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("list"),
  content: z.object({
    layout: z.enum([
      "single-column",
      "single-row",
      "flow-horizontal",
      "flow-vertical",
      "pagination"
    ]),
    defaultItem: FairyDomResourceReferenceSchema.optional(),
    lineGap: z.number().finite().optional(),
    columnGap: z.number().finite().optional(),
    lineCount: z.number().int().nonnegative().optional(),
    columnCount: z.number().int().nonnegative().optional(),
    autoResizeItem: z.boolean().optional(),
    align: alignSchema.optional(),
    verticalAlign: verticalAlignSchema.optional(),
    items: z.array(FairyDomListItemSchema)
  }).strict()
}).strict();

export const FairyDomInstanceNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("instance"),
  content: z.object({
    resource: FairyDomResourceReferenceSchema,
    text: z.string().optional(),
    icon: FairyDomResourceReferenceSchema.optional(),
    selected: z.boolean().optional(),
    properties: z.record(z.string(), z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null()
    ])).optional()
  }).strict()
}).strict();

export const FairyDomTreeNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("tree"),
  readOnly: z.literal(true),
  capability: z.literal("node.tree"),
  content: z.object({
    layout: z.enum([
      "single-column",
      "single-row",
      "flow-horizontal",
      "flow-vertical",
      "pagination"
    ]),
    defaultItem: FairyDomResourceReferenceSchema.optional(),
    lineGap: z.number().finite().optional(),
    columnGap: z.number().finite().optional(),
    items: z.array(FairyDomListItemSchema)
  }).strict()
}).strict();

export const FairyDomLoader3DNodeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal("loader3d"),
  readOnly: z.literal(true),
  capability: z.literal("node.loader3d"),
  content: z.object({
    resource: FairyDomResourceReferenceSchema.optional(),
    externalUrl: z.string().min(1).optional(),
    playing: z.boolean().optional(),
    frame: z.number().int().nonnegative().optional(),
    color: z.string().min(1).optional()
  }).strict()
}).strict();

export const FairyDomNodeSchema = z.discriminatedUnion("type", [
  FairyDomImageNodeSchema,
  FairyDomTextNodeSchema,
  FairyDomRichTextNodeSchema,
  FairyDomInputTextNodeSchema,
  FairyDomLoaderNodeSchema,
  FairyDomGraphNodeSchema,
  FairyDomMovieClipNodeSchema,
  FairyDomGroupNodeSchema,
  FairyDomListNodeSchema,
  FairyDomInstanceNodeSchema,
  FairyDomTreeNodeSchema,
  FairyDomLoader3DNodeSchema
]);
export type FairyDomNode = z.infer<typeof FairyDomNodeSchema>;

export const FairyDomNewNodeSchema = z.discriminatedUnion("type", [
  FairyDomImageNodeSchema.omit({ id: true }),
  FairyDomTextNodeSchema.omit({ id: true }),
  FairyDomRichTextNodeSchema.omit({ id: true }),
  FairyDomInputTextNodeSchema.omit({ id: true }),
  FairyDomLoaderNodeSchema.omit({ id: true }),
  FairyDomGraphNodeSchema.omit({ id: true }),
  FairyDomMovieClipNodeSchema.omit({ id: true }),
  FairyDomGroupNodeSchema.omit({ id: true }),
  FairyDomListNodeSchema.omit({ id: true }),
  FairyDomInstanceNodeSchema.omit({ id: true })
]);
export type FairyDomNewNode = z.infer<typeof FairyDomNewNodeSchema>;

export const FairyDomComponentRootSchema = z.object({
  type: z.literal("component-root"),
  id: z.string().min(1),
  name: z.string(),
  style: FairyDomStyleSchema,
  content: z.object({
    overflow: z.enum(["visible", "hidden", "scroll"]),
    scrollAxis: z.enum(["horizontal", "vertical", "both"]).optional(),
    opaque: z.boolean().optional(),
    backgroundColor: z.string().min(1).optional(),
    maskId: z.string().min(1).optional(),
    reversedMask: z.boolean().optional()
  }).strict(),
  relations: z.array(FairyDomRelationSchema),
  children: z.array(FairyDomNodeSchema)
}).strict();
export type FairyDomComponentRoot = z.infer<typeof FairyDomComponentRootSchema>;

export const FairyDomDocumentSchema = z.object({
  schemaVersion: z.literal(FAIRY_DOM_SCHEMA_VERSION),
  packageId: z.string().min(1),
  componentId: z.string().min(1),
  root: FairyDomComponentRootSchema
}).strict();
export type FairyDomDocument = z.infer<typeof FairyDomDocumentSchema>;
