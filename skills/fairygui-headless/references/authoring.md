# 原生工程编辑

完整操作和目标结构分别见 [operations](../definitions/authoring/operations.schema.json) 与 [target](../definitions/authoring/target.schema.json)。属性 Schema 以原生类型命名，例如 `GTextField.schema.json`、`Controller.schema.json`、`TransitionItem.schema.json`。

`target.kind` 定位工程、包、资源、组件、节点、控制器、页面、Gear、动效及条目。
节点使用 `packageId/componentId/nodeId`；选择器定位同时给 `expectedMatches`。
控制器与动效使用所属组件以及 `controllerName/transitionName`；页面使用 `pageId`；条目使用零基 `index`。

`create` 创建目标种类，节点另给 `type:"GTextField"` 等原生类型。
`clientRef` 对应服务器分配的目标；后续目标 ID 字段可用 `@clientRef` 引用。
资源或组件定义的身份与实例节点的身份分开处理。

`update.props` 中缺省字段保持原值，对象递归合并、数组整体替换；可空性和默认值按类型定义。
位置与尺寸为逻辑像素，旋转为度，`alpha` 为 `0..1`，枚举按定义中的原生值填写。
Group 成员仍是兄弟节点，通过 `groupId` 关联；List/Tree 项目通过其原生项目字段处理。

有 Gear 控制的字段必须显式给 `scope`：

- `"base"`：仅基础值；
- `{ "controller":"mode", "pageId":"page-id" }`：指定页面；
- `{ "controller":"mode", "allPages":true }`：全部已定义页面。

删除前可查询 `references`，默认有依赖时拒绝。`cascade:true` 请求按引用规则清理，结果仍须通过引用与回读校验。
`replace` 保留目标身份；`clone` 分配新身份并重写内部引用。迁移或复制涉及的外部依赖须在目标作用域中解析。

原生 XML 使用 `op:"xml"`，通过模型目标定位，支持 `insert/attributes/replace`。
新增片段中的 ID 是局部标签，服务分配正式 ID 并重写已知引用；`bindings` 提供显式外部映射。
通过 `query` 的 `kind:"xml"` 读取待编辑片段；关注不透明结构诊断和校验覆盖范围。
片段上限 1 MiB、深度 64；单批最多 200 项。

```json
{
  "action": "plan",
  "projectId": "p_example",
  "operations": [{
    "op": "update",
    "target": { "kind": "node", "packageId": "pkg00001", "componentId": "cmp01", "nodeId": "n0" },
    "props": { "x": 24, "text": "Hello" }
  }]
}
```

计划返回 `files`、`clientRefs`、`operationResults`、诊断和来源/结果指纹。提交将来源字节再次与磁盘比较，文件事务完成后才返回成功。
