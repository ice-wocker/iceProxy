# 安全策略

## 报告漏洞

如果你发现安全问题，**请不要直接开公开 Issue**。

优先通过 GitHub 的 [私密漏洞报告](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) 功能提交；也可以发邮件到 `ice@users.noreply.github.com`。

请在报告里尽量包含：

- 受影响的版本 / 提交
- 复现步骤或概念验证（PoC）
- 影响范围（能读到什么、能改到什么）
- 你建议的修复方向（可选）

我会尽快确认并回复。修复发布后，如果愿意，会在致谢中列出你的名字。

## 设计上的安全取向

- 不申请非必要权限（例如离线类应用不申请 `INTERNET`）
- 数据尽量只留在本机，不做静默上传
- 不内置统计 / 追踪 / 广告 SDK

## 支持的版本

只维护默认分支上的最新代码。旧版本不再单独修复。

## 注意

本项目按"现状"提供，不对适用性或安全性作任何担保，详见 LICENSE。
