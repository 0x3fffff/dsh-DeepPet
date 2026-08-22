# dsh-deep-pet-win32-x64

`dsh-deep-pet` 的 Windows x64 桌宠二进制。

这个包不该被直接安装——它是 `dsh-deep-pet` 的 `optionalDependencies`
之一，由 npm/pnpm 按 `os`/`cpu` 字段自动挑选。版本与 `dsh-deep-pet`
严格一致（精确 pin），所以插件和二进制永远同版本。

`bin/` 的内容由 CI 在发版时填入，不进 git。
