// 双面包的 host 半：无操作。真正的 UI 在 ./client。
// 这个空 apply 的存在是为了让 cordis loader 能为它建 fiber，
// 否则 dsh-client-modules 不会把它的 client 包扫进浏览器 roster。
export function apply() {}
