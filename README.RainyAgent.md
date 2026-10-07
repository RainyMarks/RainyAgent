# RainyAgent

RainyAgent 是支持 Windows 原生和 WSL2 执行环境的桌面编程 Agent。核心安装包约 325 MB，内置 Windows Host；Strata 引擎、PHP、WSL 运行环境和 38 款 CTF 工具按需下载。用户自行选择主模型与配套 MTP 权重，也可连接其他本地服务或 API。编辑器、AI 对话、项目终端、运行与调试、项目记忆及人工工具工作台在同一个窗口中使用。

- [项目首页与 Windows 最新版下载](README.zh.md)
- [安装、模型设置与源码构建](apps/rainy-desktop/README.zh-CN.md)
- [桌面功能与运行环境](apps/rainy-desktop/README.zh.md)
- [按产物记录的验收结果](apps/rainy-desktop/VALIDATION.md)
- [上游来源、授权与第三方许可](apps/rainy-desktop/THIRD_PARTY_NOTICES.md)

新安装默认使用 Windows，手动打开的文件夹就是项目；WSL 和离线环境组件可按需选择。模型发现只需连接信息，保存与诊断仍需完整模型配置。稳定版更新在启动时检查并后台下载，只有确认重启且草稿保存完成后才安装；普通退出不会安装，也不会重新下载已下载的工具和可选组件。

独立应用标识为 `dev.rainy.agent`。Windows 载体设置保存在 `%APPDATA%\RainyAgent`，所选 Host 的数据保存在用户的 `.rainy-agent` 目录。项目可复用已有 Python、Conda 和虚拟环境；组件导入不修改全局 PATH。安装后直接使用，无需设备码、激活码或授权管理器。

## 内置本地推理

Strata 推理引擎（约 560 MB，在设置中按需下载）面向 Windows x64、NVIDIA CUDA 13 和 580 以上驱动，内含 `sm75/sm86/sm89/sm120` 目标，不承诺 AMD 或 Linux 推理。用户提供受支持的 Qwen3.8 Flash Next 主模型 GGUF 全部分片及配套 MTP GGUF 或已准备目录；发行包不含模型权重或派生 dense/expert 文件。选择文件或保存设置不会启动模型，点击启动后才在本机离线准备运行文件。设置页可调整上下文、端口、KV 缓存、显存保留和常驻 RAM，取消启动或停止本应用拥有的进程。连接前由当前 Host 检查实际模型与窗口；WSL NAT 无法访问 Windows loopback 时使用 Windows 执行环境。真实 GPU 推理和性能范围以[验收记录](apps/rainy-desktop/VALIDATION.md)为准。

## 使用许可

RainyAgent 集成代码采用 [RainyAgent Source Available License 1.0](LICENSE.RainyAgent)。允许个人和企业内部免费使用、修改及非商业再分发；销售、收费托管和商业再分发需要另行书面许可。独立项目和输出可用于商业用途。本项目属于源码可用项目，不是 OSI 认可的开源项目。

DeepSeek Harness 基线及其原有包目录中的改动继续适用 [MIT](LICENSE.upstream)。项目维护者已确认获得 IceSky 作者针对本项目公开再分发的授权；各第三方组件的原有许可证、版权与声明继续保留，具体见[第三方说明](apps/rainy-desktop/THIRD_PARTY_NOTICES.md)。
