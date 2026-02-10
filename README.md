# IP Changer - Linux 网络配置管理面板

基于 Node.js 的 Web 面板，通过 SSH 远程管理 Linux 服务器的 IP 与网络配置（支持 Ubuntu、Debian、CentOS 等）。

---

## 安装步骤

### 前置要求
- 已安装 [Node.js](https://nodejs.org/)（建议 v16 或更高）。
- 目标 Linux 服务器已开启 SSH 服务。

### 1. 克隆/下载项目
```bash
git clone <项目地址>
cd IP-changer
```

### 2. 安装依赖
```bash
npm install
```

### 3. 启动应用
```bash
npm start
```
默认在 `http://localhost:3000` 运行。

---

## 使用说明

### 1. 连接服务器
- 浏览器访问 `http://localhost:3000`。
- 左侧点击 **「Add Host」**。
- 填写服务器 **IP**、**SSH 端口**（默认 22）、**用户名** 以及 **密码** 或 **私钥**。
- 点击 **「Connect」**，系统会检测发行版并加载当前网络接口。

### 2. 查看网络状态
- 连接成功后，中间面板显示所有网卡（如 `eth0`、`ens33`）及当前 IP、子网掩码、网关。

### 3. 修改 IP 配置
- **添加 IP**：在「Apply Static Config」输入 IP 或范围（如 `192.168.1.10/24`），选择网卡后点击 **「Apply」**。
- **删除 IP**：在接口详情中点击对应 IP 旁的删除图标。
- **DNS/网关**：修改输入框后提交。

### 4. 使用终端
- 点击右上角 **「Terminal」** 打开与服务器同步的命令行窗口。

### 5. 测试连接
- 在 IP 旁点击 **「Ping」** 图标，可用该 IP 作为源地址 ping 8.8.8.8 并查看延迟。
