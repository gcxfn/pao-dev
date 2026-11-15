/** 内核对象的可选 undefined 字段在 JSON 服务边界省略，不改变源对象。 */
export function wireValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
