/** 桌面跨视图的路径比较键；不读盘、不解析相对路径，不用于权限校验。 */
export function desktopPathKey(
  path: string,
  windows = /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path),
): string {
  const slashes = path.replace(/\\/g, "/");
  const normalized =
    slashes === "/" || /^[a-z]:\/$/i.test(slashes) ? slashes : slashes.replace(/\/+$/, "");
  return windows ? normalized.toLowerCase() : normalized;
}
