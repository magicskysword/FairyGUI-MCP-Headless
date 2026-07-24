# FairyGUI DOM 编写参考

本参考用于编写 `fairygui.apply_dom_patch`。公开工具 Schema 只描述五种操作骨架；
`node` 和 `changes` 会在服务内部按这里的完整类型进行第二次校验。写入前仍应以
`fairygui.query` 的 `detail:"full"` 结果确认目标当前字段。

## 1. 通用规则

`insert.node` 与 `replace.node` 的通用结构：

```json
{
  "type": "text",
  "name": "title",
  "groupId": "layout",
  "style": {},
  "relations": [],
  "content": { "text": "Hello" }
}
```

| 字段 | insert/replace | update | 规则 |
|---|---|---|---|
| `type` | 必填 | 禁止 | 类型变化必须使用 `replace` |
| `name` | 必填，可为空字符串 | 可改；不可空 | 节点显示名，不是资源名 |
| `groupId` | 可选 | 可改；可空 | `null` 清除 Group 归属 |
| `style` | 必填对象 | 可局部改；对象内字段可空 | 公共 CSS 风格名 |
| `relations` | 必填数组 | 可整体替换；不可空 | 数组采用整体替换 |
| `content` | 必填对象 | 可按类型局部改；可选字段可空 | 每种节点有独立契约 |

服务端字段 `id`、`readOnly`、`capability` 不能出现在 `node`，也不能出现在
`update.changes`。`insert` 通过 `clientRef` 生成 ID；`replace` 保留被替换节点的
稳定 ID。

所有写目标都必须给 `expectedMatches`。`update`、`move`、`remove`、`replace`
必须且只能给 `selector` 或 `targetRef`：

- `selector` 定位已有节点；
- `targetRef` 只能定位本批中更早执行的 `insert.clientRef`；
- `targetRef` 的 `expectedMatches` 必须为 `1`；
- Relation `targetId` 与 `groupId` 可以引用已有稳定 ID 或同批 `clientRef`。

### 受限 Merge Patch

`update.changes` 使用受限 Merge Patch：

- 字段缺省：保持原值；
- 对象：递归合并；
- 数组：整体替换；
- `null`：清除可选字段并恢复 FairyGUI 默认值；
- 必填字段：不能设为 `null`；
- `id/type/readOnly/capability`：始终禁止修改。

例如：

```json
{
  "op": "update",
  "selector": "#n3",
  "expectedMatches": 1,
  "changes": {
    "style": { "left": 40, "opacity": null },
    "content": { "color": null }
  }
}
```

这只修改 `left`，清除显式透明度与颜色；其他 style/content 字段不变。

## 2. 公共 style

`style` 对象本身在 `node` 中必填，各子字段均可选。下表字段在 `update.style`
中可空；`null` 恢复运行时默认值。

| 字段 | 类型/范围 | 默认 |
|---|---|---|
| `left`, `top` | finite number | `0` |
| `width`, `height` | finite number，`>=0` | `0` |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | finite number，`>=0` | `0` |
| `opacity` | finite number，`0..1` | `1` |
| `rotation` | finite number | `0` |
| `scaleX`, `scaleY` | finite number | `1` |
| `skewX`, `skewY` | finite number | `0` |
| `pivotX`, `pivotY` | finite number | `0` |
| `pivotAsAnchor` | boolean | `false` |
| `visible` | boolean | `true` |
| `touchable` | boolean | `true` |
| `grayed` | boolean | `false` |

不接受 `x/y/alpha` 别名、`px` 字符串、百分比、`calc()` 或浏览器布局属性。

组件根只可写以下 style：`width`、`height`、`minWidth`、`maxWidth`、
`minHeight`、`maxHeight`、`pivotX`、`pivotY`、`pivotAsAnchor`。根节点不支持
`left/top/opacity/...`。

## 3. 资源引用

资源引用始终是：

```json
{ "packageId": "pkg00001", "resourceId": "img01" }
```

两个字段都必填且非空。image 只接受图片资源，movie-clip 只接受 MovieClip，
List 的 `defaultItem` 与 item `resource` 只接受组件，instance `resource` 只接受
组件，文本 `font` 只接受字体资源。类型不兼容返回 `INVALID_PATCH`。

## 4. Relations

Relation 项结构：

```json
{
  "targetId": "n1",
  "type": "Left_Left",
  "percent": false
}
```

`targetId` 与 `type` 必填；`percent` 为 boolean，省略时默认 `false`。Relations
数组整体替换。`targetId` 可为组件根 ID、同组件节点 ID 或同批 `clientRef`。

全部 25 种 `type`：

```text
Left_Left, Left_Center, Left_Right,
Center_Center,
Right_Left, Right_Center, Right_Right,
Top_Top, Top_Middle, Top_Bottom,
Middle_Middle,
Bottom_Top, Bottom_Middle, Bottom_Bottom,
Width, Height,
LeftExt_Left, LeftExt_Right,
RightExt_Left, RightExt_Right,
TopExt_Top, TopExt_Bottom,
BottomExt_Top, BottomExt_Bottom,
Size
```

## 5. 节点 content

以下“可选，可空”表示字段可在 `update.changes.content` 中用 `null` 清除；在
`insert.node` 或 `replace.node` 中不要传 `null`。

### image

`type:"image"`；`content` 没有必填子字段。

| 字段 | 规则 |
|---|---|
| `resource` | 可选，可空；图片资源引用 |
| `flip` | 可选，可空；`none|horizontal|vertical|both` |
| `fillMethod` | 可选，可空；`none|horizontal|vertical|radial-90|radial-180|radial-360` |
| `fillAmount` | 可选，可空；finite number，`0..1` |
| `color` | 可选，可空；非空颜色字符串 |

### text

`type:"text"`；`content.text` 必填 string，不能设为 `null`。

| 字段 | 规则 |
|---|---|
| `font` | 可选，可空；字体资源引用 |
| `fontSize` | 可选，可空；finite number，`>0` |
| `color` | 可选，可空；非空颜色字符串 |
| `align` | 可选，可空；`left|center|right` |
| `verticalAlign` | 可选，可空；`top|middle|bottom` |
| `autoSize` | 可选，可空；`none|both|height|shrink` |
| `singleLine`, `bold`, `italic`, `underline`, `strikethrough` | 可选，可空；boolean |
| `lineSpacing`, `letterSpacing` | 可选，可空；finite number |

### rich-text

`type:"rich-text"`；继承 text 的全部字段与必填 `text`，另有：

| 字段 | 规则 |
|---|---|
| `ubb` | 可选，可空；boolean |

### input-text

`type:"input-text"`；继承 text 的全部字段与必填 `text`，另有：

| 字段 | 规则 |
|---|---|
| `prompt`, `restrict` | 可选，可空；string |
| `maxLength` | 可选，可空；integer，`>=0` |
| `password` | 可选，可空；boolean |
| `keyboardType` | 可选，可空；`default|number|url|email|phone` |

### loader

`type:"loader"`；`content` 没有必填子字段。`resource` 与 `externalUrl` 互斥。

| 字段 | 规则 |
|---|---|
| `resource` | 可选，可空；资源引用 |
| `externalUrl` | 可选，可空；非空 string |
| `fill` | 可选，可空；`none|scale|scale-match-height|scale-match-width|scale-free|scale-no-border` |
| `align` | 可选，可空；`left|center|right` |
| `verticalAlign` | 可选，可空；`top|middle|bottom` |
| `autoSize`, `playing` | 可选，可空；boolean |
| `frame` | 可选，可空；integer，`>=0` |

### graph

`type:"graph"`；`content.shape` 必填且不能设为 `null`。

| 字段 | 规则 |
|---|---|
| `shape` | 必填；`empty|rectangle|ellipse|polygon|regular-polygon` |
| `fillColor`, `lineColor` | 可选，可空；非空颜色字符串 |
| `lineSize` | 可选，可空；finite number，`>=0` |
| `cornerRadius` | 可选，可空；恰好 4 个 `>=0` 的 finite number |
| `sides` | 可选，可空；integer，`>=3` |
| `points` | 可选，可空；`[{x:number,y:number},...]`，数组整体替换 |

### movie-clip

`type:"movie-clip"`；`content` 没有必填子字段。

| 字段 | 规则 |
|---|---|
| `resource` | 可选，可空；MovieClip 资源引用 |
| `playing` | 可选，可空；boolean |
| `frame` | 可选，可空；integer，`>=0` |
| `color` | 可选，可空；非空颜色字符串 |

### group

`type:"group"`；`content.layout` 必填且不能设为 `null`。

| 字段 | 规则 |
|---|---|
| `layout` | 必填；`none|horizontal|vertical` |
| `lineGap`, `columnGap` | 可选，可空；finite number |
| `excludeInvisibles`, `autoSizeDisabled` | 可选，可空；boolean |
| `mainGridIndex` | 可选，可空；integer，`>=-1` |
| `mainGridMinSize` | 查询可见，但 V1 不可写；传入返回 `CAPABILITY_NOT_IMPLEMENTED` |

Group 不是容器。成员仍是组件根的直接子节点，通过成员的 `groupId` 指向 Group
节点。`groupId` 必须引用同组件的 group 稳定 ID 或同批 group `clientRef`。

### list

`type:"list"`；V1 只写静态 List。`content.layout` 与 `content.items` 必填，均
不能设为 `null`。

| 字段 | 规则 |
|---|---|
| `layout` | 必填；`single-column|single-row|flow-horizontal|flow-vertical|pagination` |
| `items` | 必填数组；update 时整体替换 |
| `defaultItem` | 可选，可空；组件资源引用 |
| `lineGap`, `columnGap` | 可选，可空；finite number |
| `lineCount`, `columnCount` | 可选，可空；integer，`>=0` |
| `autoResizeItem` | 可选，可空；boolean |
| `align` | 可选，可空；`left|center|right` |
| `verticalAlign` | 可选，可空；`top|middle|bottom` |

List item 不是普通 DOM 子节点。每项可含：

| 字段 | 规则 |
|---|---|
| `name`, `title`, `selectedTitle` | 可选 string |
| `icon`, `selectedIcon` | 可选资源引用 |
| `resource` | 可选组件资源引用 |

虚拟 List 与 Tree 的结构写入是 planned/read-only；不要用普通子节点模拟 List
items。

### instance

`type:"instance"`；`content.resource` 必填组件资源引用，不能清除。

| 字段 | 规则 |
|---|---|
| `resource` | 必填；组件资源引用 |
| `text` | 可选，可空；仅 Button/Label/ComboBox 等支持标题覆盖的扩展 |
| `icon` | 可选，可空；仅支持图标覆盖的扩展 |
| `selected` | 可选，可空；仅支持选中覆盖的扩展 |
| `properties` | 查询可见；自定义扩展属性在 V1 只读 |

instance 是边界节点，不能向其内部 insert，也不能用选择器跨越它写来源组件。
应查询来源组件并对其执行独立 patch。

### 组件根

组件根通过选择器 `component-root` 更新，不能 insert、move、remove 或 replace。
根名称属于资源元数据，重命名使用资源操作。可写：

- 上述受限根 style；
- `relations` 整体数组；
- `content.overflow`：必填，`visible|hidden|scroll`；
- `content.scrollAxis`：可选，可空，`horizontal|vertical|both`，仅在
  `overflow:"scroll"` 时合法；
- `content.opaque`：可选，可空，boolean；
- `content.backgroundColor`：可选，可空，非空颜色字符串；
- `content.maskId`：可选，可空，节点 ID 或同批 `clientRef`；
- `content.reversedMask`：可选，可空，boolean；为 `true` 时必须有 `maskId`。

## 6. 五种操作范例

### insert

```json
{
  "op": "insert",
  "parentSelector": "component-root",
  "expectedMatches": 1,
  "clientRef": "newTitle",
  "index": 0,
  "node": {
    "type": "text",
    "name": "title",
    "style": { "left": 20, "top": 10, "width": 200, "height": 40 },
    "relations": [],
    "content": { "text": "Hello", "fontSize": 24 }
  }
}
```

V1 的 `parentSelector` 必须匹配组件根一次。

### update

```json
{
  "op": "update",
  "selector": "text[name=\"title\"]",
  "expectedMatches": 1,
  "changes": {
    "style": { "left": 32, "opacity": 0.8 },
    "content": { "text": "Updated" }
  }
}
```

多目标 update 可以让 `expectedMatches>1`，但服务会先确认全部目标类型与能力都
兼容；任一目标不兼容则整条操作不修改任何目标。

同批新节点可用：

```json
{
  "op": "update",
  "targetRef": "newTitle",
  "expectedMatches": 1,
  "changes": { "content": { "color": "#ffffff" } }
}
```

### move

```json
{
  "op": "move",
  "selector": "#n3",
  "expectedMatches": 1,
  "toIndex": 2
}
```

`toIndex` 是组件根显示列表中的零基索引。

### remove

```json
{
  "op": "remove",
  "selector": "[name=\"obsolete\"]",
  "expectedMatches": 2
}
```

删除会清理 V1 支持的 Relation、Group 与 mask 引用。不能删除组件根。

### replace

```json
{
  "op": "replace",
  "selector": "#n3",
  "expectedMatches": 1,
  "node": {
    "type": "graph",
    "name": "replacement",
    "style": { "width": 120, "height": 40 },
    "relations": [],
    "content": { "shape": "rectangle", "fillColor": "#334455" }
  }
}
```

replace 必须匹配一个节点，保留原 ID，并删除原节点所属的不透明扩展内容。Tree、
Loader3D 与其他 planned 节点不能作为新节点写入。

## 7. 完整批次示例

```json
{
  "projectId": "p_...",
  "packageId": "pkg00001",
  "componentId": "cmp01",
  "operations": [
    {
      "op": "insert",
      "parentSelector": "component-root",
      "expectedMatches": 1,
      "clientRef": "layout",
      "node": {
        "type": "group",
        "name": "layout",
        "style": {},
        "relations": [],
        "content": { "layout": "horizontal", "columnGap": 8 }
      }
    },
    {
      "op": "insert",
      "parentSelector": "component-root",
      "expectedMatches": 1,
      "clientRef": "label",
      "node": {
        "type": "text",
        "name": "label",
        "groupId": "layout",
        "style": { "width": 160, "height": 30 },
        "relations": [{
          "targetId": "layout",
          "type": "Left_Left",
          "percent": false
        }],
        "content": { "text": "Created in one batch" }
      }
    },
    {
      "op": "update",
      "targetRef": "label",
      "expectedMatches": 1,
      "changes": { "style": { "opacity": 0.9 } }
    }
  ]
}
```

成功结果中的 `clientRefs` 给出 `layout` 与 `label` 的稳定节点 ID。后续 query、
render 和新批次应使用这些 ID 或准确选择器，不再使用已经离开该批次作用域的
`targetRef`。
