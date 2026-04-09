# Synapse Framework Diagram Nano Banana Prompt

## 结论先说

是，应该改成“一个虚拟的 conversation 对话界面”来承载整张图。

原因很直接：

1. Synapse 的核心不是抽象组件关系，而是“协作发生在同一条 conversation 里”。
2. 你最想表达的对象差异，不适合靠一堆概念词标签表达，适合放进同一个对话现场里自然呈现。
3. Actor、Remote Agent、外部 IM、资源授权、事件驱动、跨 workspace 分享，这些都可以围绕一个 conversation UI 被看懂。

## 推荐画法

不要画成传统架构图。

要画成：

- 一个虚拟的 `Synapse conversation` 主界面，作为整张图的主体。
- 对话框里同时出现多种参与对象。
- 每种参与对象通过头像、气泡样式、状态徽标、侧边能力卡片来表达差异。
- 资源和授权不要单独画成抽象云朵，要画成 conversation 旁边的“可用资源区 / 受控能力区”。
- workspace、cross-workspace share、events 不做主视觉中心，而做外围结构，让人看出这是 conversation 背后的系统设计。

## 这张图真正要表达的内容

### 1. Conversation 是核心运行时

整张图的主画面就是一个共享 conversation。

这个 conversation 里可以同时有：

- Human
- Actor
- Remote Agent
- External IM participant

### 2. 不同参与对象在同一条线上协作

要让观者一眼看出来：

- 人类在对话里发起任务和管理授权。
- Actor 是平台原生运行时，不只是一个聊天机器人。
- Remote Agent 是外部 harness/runtime，但仍然通过 conversation 参与协作。
- 外部 IM 不是单独系统，而是被 conversation 吸收进来的外部参与通道。

### 3. Actor 的“框架能力”要被视觉化

不要写很多字去解释 Actor。

要通过紧贴 Actor 的小型结构卡片或微型图标暗示：

- loop
- memory
- skills
- MCP / tools
- planning / execution

重点是让人感觉：

`Actor = 平台原生、被管理的 agent runtime`

而不是：

`Actor = 一个会回复消息的 bot`

### 4. Resource 必须独立于 Actor

资源不要画成挂在某个 Actor 身上的附属物。

资源应该画成 conversation 右侧或下方的受控资源区，例如：

- Plugins
- Skills
- MCP Relay
- Event Sources

资源区应该明确表达：

- resource 是独立资产
- conversation 可以被授权使用 resource
- actor 是否能用 resource 由 authorization 决定，不是先天绑定

### 5. Authorization 是核心机制

授权系统不要只写一个词。

应该画成资源区前面的“gate / control / permission layer”，表达：

- 人类负责管理授权
- Actor 在授权控制下使用资源
- conversation scope 可以成为授权边界
- 别的 workspace 的 actor 被加入后，也可以在你的授权下使用你这边 conversation 可用的资源

### 6. Workspace 是隔离边界，但支持分享

workspace 最好作为外围边界来画，而不是占据中间。

要表达：

- workspace 是隔离与治理单元
- Actor 和 Remote Agent 可以像好友一样被跨 workspace 分享
- 被分享进来的对象，不只是参与聊天，还可以在授权下参与实际工作

### 7. Events 是 conversation 的外部驱动

事件驱动不要单独画成复杂流程图。

只需要从画面顶部或外缘引入两类驱动：

- schedule
- event source

再用一条简洁的流线指向 conversation 或 Actor，表达：

- event can wake
- event can route work
- event can start collaboration

## 主提示词

下面这版是我建议你优先使用的 prompt。它不是纯架构图，而是“产品界面场景 + 架构信息可视化”。

```text
Create a premium conceptual product illustration for a platform called Synapse.

The image should NOT look like a traditional enterprise architecture diagram.
The image should NOT look like a deployment diagram, cloud diagram, database diagram, or vendor comparison chart.

The main composition should be a fictional Synapse conversation interface.
This conversation UI is the heart of the entire image.

Inside one shared conversation, show multiple participant types coexisting in the same thread:
- Human
- Actor
- Remote Agent
- External IM

The conversation should feel like a real collaborative room, not an abstract chat bubble.
Use a polished product-UI-meets-editorial-illustration style.

The Human appears as the initiator, coordinator, and authorization manager.
The Actor appears as a native managed runtime inside the platform, not as a generic chatbot.
The Remote Agent appears as an external runtime that still joins the same conversation as a first-class participant.
The External IM participant appears as an inbound bridged participant coming from outside the platform, but without any brand logos.

Very important:
the picture must communicate the system through the conversation scene itself, not through lots of explanatory text.

Show the Actor with a subtle attached capability panel, compact and elegant, using small visual modules or icons to imply:
- loop
- memory
- skills
- MCP or tool access
- planning and execution

Show the Remote Agent with a distinct external-runtime identity:
- slightly separate visual language from the native Actor
- still inside the same conversation
- connected through a bridge-like cue, not a separate subsystem box

Show the External IM participant as an outside communication endpoint absorbed into the same conversation flow.
Do not use WeChat, Feishu, DingTalk, Claude Code, Codex, Gemini, or any product logo.

On the right side of the conversation, show a controlled Resources area.
This area should feel like a live capability dock for the current conversation, not a static legend.
Represent resources as modular assets such as:
- Plugins
- Skills
- MCP Relay
- Event Sources

Place an Authorization layer between the participants or conversation and the Resources area.
This should look like a clear permission gate or governance control surface.
The image should make it obvious that:
- resources are independent from any single actor
- actors do not own resources by default
- access is granted by authorization
- conversation-scoped access is possible

Show that a shared Actor from another workspace can join this conversation and, when authorized, use local conversation resources.
This should be expressed visually with workspace boundary cues and a tasteful cross-workspace sharing hint.

Show Workspaces as soft outer boundary regions or layered environments around the main conversation scene.
They should communicate isolation and governance, but not distract from the central conversation.

From the outer edge or top of the image, show Events entering the system:
- scheduled trigger
- external event source

These event flows should route into the same conversation-centric runtime and wake collaboration.

The overall story of the image should be:
- collaboration happens inside conversation
- multiple participant types share the same thread
- Actor is a native managed runtime
- Remote Agent is an external runtime joining the same collaboration model
- resources are independent assets
- authorization governs capability use
- workspaces isolate ownership but still allow controlled sharing
- events can wake and route work into the conversation

Visual style:
- premium product concept art
- elegant 2D interface illustration
- hybrid of UI mockup and systems poster
- light background
- restrained palette: deep navy, teal, soft cyan, warm amber
- crisp glass panels, soft shadows, smooth connectors
- large central conversation window
- minimal but meaningful labels
- mostly visual explanation, very little text
- high readability at a glance
- sophisticated, calm, confident

Avoid:
- big blocks of explanatory text
- generic architecture boxes and arrows everywhere
- server racks, Kubernetes, cloud icons
- database tables
- dense labels
- brand logos
- technical API details
- clutter

Allowed labels only:
- Synapse
- Conversation
- Human
- Actor
- Remote Agent
- External IM
- Resources
- Authorization
- Workspace
- Events

Landscape format, one dominant conversation UI, strong visual hierarchy, architecture expressed through interaction and structure, not through text-heavy annotation.
```

## 更像“产品首页 Hero 图”的版本

如果你希望它更像官网主视觉，而不是偏信息图，可以用这版。

```text
Create a product hero illustration for Synapse based on one fictional conversation screen.

The screen should show one shared conversation where Human, Actor, Remote Agent, and External IM all appear together as first-class participants.

Use the conversation itself as the storytelling device.
Do not explain the system with paragraphs.
Instead, reveal the framework through visual cues:
- the Actor has a native runtime side panel with memory, skills, MCP, planning, loop
- the Remote Agent has an external-runtime identity but still participates in the same thread
- a controlled Resources dock shows Plugins, Skills, MCP Relay, Event Sources
- an Authorization gate sits between the conversation and resources
- subtle workspace boundary cues show controlled cross-workspace sharing
- event triggers enter from outside and wake the same collaboration flow

Style:
- premium SaaS hero image
- clean UI concept art
- elegant 2D glassmorphism and editorial shapes
- light background
- deep navy, teal, cyan, amber palette
- minimal text
- no logos
- no infra diagram look

The message is: Synapse is conversation-centric collaborative runtime infrastructure.
```

## 更像“结构说明图”的版本

如果你还是希望保留一点“框架图感”，但不要太抽象，可以用这版。

```text
Create a conversation-centric framework diagram for Synapse using one large fictional conversation window as the center.

Do not build the image out of isolated architecture boxes.
Instead, use the conversation window as the core stage where all participant types appear:
- Human
- Actor
- Remote Agent
- External IM

Then place three supporting structural zones around the conversation:
1. Actor runtime cues: loop, memory, skills, MCP, planning
2. Authorization and Resources: Plugins, Skills, MCP Relay, Event Sources
3. Workspace and Event boundaries: workspace isolation, cross-workspace sharing, schedule and external triggers

The result should feel like a hybrid of a product UI diagram and a systems illustration.
Low text, high concept clarity, premium visual design, light background, no vendor logos, no infrastructure detail.
```

## 我帮你再压缩成一句视觉指令

如果你在对话里只想先试一句，可以先丢这句：

```text
Draw Synapse as one shared conversation interface where Human, Actor, Remote Agent, and External IM collaborate in the same thread, while Actor runtime traits, authorization-controlled resources, cross-workspace sharing, and event-driven wakeups are expressed through elegant side panels and structural cues rather than text.
```

## 为什么这版比上一版更适合你

上一版的问题是：

- 太像“理念架构海报”
- participation 不够具体
- Actor 和 Remote Agent 的差异容易沦为文字标签
- resource / authorization / workspace / events 的关系虽然对，但不够“可感知”

这一版的好处是：

- 把 `conversation` 直接变成主舞台
- 把多参与对象真实放在一个现场里
- 把抽象机制变成 UI 结构和视觉关系
- 更符合 Synapse 的产品气质，而不是传统软件架构图气质

## 这版 prompt 仍然基于哪些实现判断

- `conversation` 是核心协作真相源
- conversation 参与者已覆盖 actor、remote agent、external 等类型
- actor session / wakeup / runtime 已有完整运行时语义
- resource 已抽象为独立能力对象，而非 actor 私有附属物
- 授权目标支持 workspace / conversation / actor / actor_in_conversation
- remote agent 与 actor 都支持可分享关系
- automation / event source 已作为原生系统能力建模

## 第二张图：跨工作区共享与当前工作区资源授权

这张图建议不要再以“多参与对象差异”为重点，而是专门讲清楚三件事：

1. `user`、`actor`、`remote agent` 都可以跨 workspace 被分享。
2. `shared user` 和 `shared actor` 被分享进当前 workspace / 当前 conversation 之后，仍然可以在授权下使用“当前工作区拥有的资源”。
3. `shared remote agent` 更像一个远端 Actor 或外部 harness runtime。它会被桥接进 conversation，但它本身有自己的 skills / plugins / tools 机制，不应该被画成通过我们平台的 authorization 去访问当前 workspace 里受限的 plugins、skills 等资源。

同时再补上一层事件源结构：

4. `Event Sources` 有两大类型：
   - 定时任务
   - 事件触发
5. 事件触发的事件源再分成：
   - 自定义注册的 Webhook
   - 由 Plugins 自动注册的 Integration Event Sources
6. Plugin 自动注册事件源的典型视觉例子可以画：
   - GitLab
   - GitHub
   - Figma

### 这张图最适合的画面结构

- 中间是 `Current Workspace` 的一个 conversation。
- 左侧或上方是多个 `Other Workspaces`。
- 从其他 workspaces 过来三类被分享对象：
  - shared user
  - shared actor
  - shared remote agent
- `shared remote agent` 旁边单独带一个轻量的 `Own Runtime` / `External Harness` 能力区。
- 这个 remote agent 能力区里可以出现几个文字示例标签：
  - Codex
  - Claude Code
  - Kimi
  - OpenClaw
  - OpenCode
- 右侧是 `Workspace Resources` 区。
- 资源区前面有一个 `Authorization` gate。
- 资源区里清楚放出：
  - Plugins
  - Skills
  - MCP Relay
  - Event Sources
- `MCP Relay` 再展开成几类典型设备：
  - Desktop
  - Linux Headless Server
  - Mobile
- `Desktop MCP Relay` 旁边展开典型工具：
  - CUA
  - Filesystem
  - Browser
  - Command Line
- `Event Sources` 再展开成两层：
  - Scheduled Jobs
  - Event Triggered
- `Event Triggered` 再展开成：
  - Custom Webhook
  - Plugin-Registered Sources
- `Plugin-Registered Sources` 的典型例子：
  - GitLab
  - GitHub
  - Figma

### 这张图想让人一眼看懂的话

- share 的不是只有 Actor，用户和 Remote Agent 也能 share
- shared user 和 shared actor 进来后不是只能聊天，而是可以在授权下干活
- resource 的归属是 workspace
- resource 的使用权可以授予给当前 conversation 里的本地参与者以及被分享进来的 user / actor
- 当前 workspace 的资源，可以服务于被分享进来的跨 workspace 参与者
- shared remote agent 是被桥接进来的外部 runtime，不应该被画成通过当前 workspace 的 authorization 去使用受限的 platform plugins / skills
- shared remote agent 应该被画成“带着自己的能力体系接入 conversation”
- event sources 也是当前 workspace 的资源组成部分
- 事件既可以来自定时任务，也可以来自 webhook 和 plugin 自动注册的外部事件

## 第二张图主提示词

```text
Create a conceptual product illustration for Synapse focused on cross-workspace sharing and workspace-owned resources.

This image should be centered on one current workspace conversation.
Do not make it a traditional architecture diagram.
Do not make it text-heavy.
Use a premium UI-meets-systems-illustration style.

Main story:
users, actors, and remote agents can all be shared across workspaces, but they do not behave the same after entering the current workspace conversation:
- shared users and shared actors can be granted access to current-workspace resources
- shared remote agents participate through a bridge and keep their own external runtime stack with their own tools, skills, and plugins

Composition:
- center: one large conversation interface labeled Synapse
- left or upper-left: multiple other workspace zones
- from those other workspaces, show three kinds of shared participants entering the current conversation:
  - shared user
  - shared actor
  - shared remote agent
- attach a separate compact external runtime panel to the shared remote agent
- inside that panel, show plain text example tags such as:
  - Codex
  - Claude Code
  - Kimi
  - OpenClaw
  - OpenCode
- right side: a workspace-owned resources panel labeled Resources
- between the conversation and the resources panel: an Authorization gate or control layer

The image must clearly communicate that:
- sharing works across workspace boundaries
- the shared participant still becomes part of the current conversation
- access to current-workspace resources comes from authorization in the current workspace
- shared users and shared actors are not limited to chatting only
- shared users and shared actors can use current-workspace resources when granted
- shared remote agents are bridged collaborators, not platform-managed consumers of restricted workspace plugins or skills

Very important:
show Plugins, Skills, and MCP Relay as workspace-level resources belonging to the current workspace, not to any individual actor.
Also show Event Sources as part of the same workspace-owned resource layer.

Represent the Resources panel as a workspace infrastructure dock with four main modules:
- Plugins
- Skills
- MCP Relay
- Event Sources

Inside the MCP Relay module, show three typical relay environments:
- Desktop
- Linux Headless Server
- Mobile

For the Desktop MCP Relay, show four typical tool surfaces as compact tool cards or icons:
- CUA
- Filesystem
- Browser
- Command Line

The image should make it visually obvious that:
- Desktop MCP Relay exposes rich local tools
- MCP Relay is part of workspace-owned infrastructure
- platform-native actors consume relay capabilities only through authorization
- shared remote agents should not be depicted as consuming workspace relay capabilities through the same path

Inside the Event Sources module, show two major categories:
- Scheduled Jobs
- Event Triggered

Inside Event Triggered, show two subtypes:
- Custom Webhook
- Plugin-Registered Sources

Inside Plugin-Registered Sources, show common visual examples:
- GitLab
- GitHub
- Figma

The image should make it visually obvious that:
- event sources are also workspace-owned resources
- some event sources are manually registered webhooks
- some event sources are automatically created or managed through plugins
- events can enter the current workspace collaboration runtime and wake work

The current workspace should feel like the owner of the resources.
The imported shared user, shared actor, and shared remote agent should feel like trusted foreign participants entering the local collaboration space.
The shared remote agent should feel like an external full-stack agent framework being bridged into the conversation, not a platform-native actor.

Use visual cues for cross-workspace sharing:
- soft workspace boundary regions
- dotted or bridged connection lines
- participant cards traveling from other workspace zones into the current conversation

Use visual cues for authorization:
- a permission gate
- access lines passing through the gate before reaching resources
- controlled, selective connections rather than open unrestricted connections
- connect shared user and shared actor through the authorization path
- do not connect shared remote agent through the same authorization path to restricted workspace plugins or skills

Use visual cues for the remote agent bridge:
- a bridge line into the conversation
- a separate external runtime cluster
- small module chips implying own tools, own skills, own plugins
- no direct consumption line from the remote agent into the workspace-owned restricted resource dock

The overall message should be:
- users, actors, and remote agents are all shareable across workspaces
- current workspace resources remain owned by the current workspace
- shared users and shared actors can be granted current-workspace resources
- shared remote agents join the same conversation but retain their own external capability stack
- cross-workspace collaboration and local resource governance coexist
- MCP Relay is a key workspace resource layer
- Event Sources are also a key workspace resource layer
- event-driven automation includes scheduled jobs and triggered events
- triggered events can come from custom webhooks or plugin-registered sources

Visual style:
- premium product concept illustration
- elegant 2D interface infographic
- light background
- deep navy, teal, soft cyan, warm amber palette
- glass panels and soft structural connectors
- visually rich but not cluttered
- mostly explained through structure, not text
- highly legible at a glance

Avoid:
- paragraphs
- logos
- enterprise cloud diagrams
- Kubernetes or server rack imagery
- dense box-and-arrow architecture
- too many labels

Allowed labels only:
- Synapse
- Workspace
- Conversation
- Shared User
- Shared Actor
- Shared Remote Agent
- External Harness
- Own Runtime
- Own Tools
- Own Skills
- Own Plugins
- Resources
- Authorization
- Plugins
- Skills
- MCP Relay
- Event Sources
- Desktop
- Linux Headless Server
- Mobile
- CUA
- Filesystem
- Browser
- Command Line
- Scheduled Jobs
- Event Triggered
- Custom Webhook
- Plugin-Registered Sources
- GitLab
- GitHub
- Figma
- Codex
- Claude Code
- Kimi
- OpenClaw
- OpenCode

Landscape format, one dominant current-workspace conversation, clear workspace-owned resource layer, elegant cross-workspace sharing cues, architecture expressed through visual relationships.
```

## 第二张图更极简的版本

```text
Draw Synapse as one current-workspace conversation receiving a shared user, a shared actor, and a shared remote agent from other workspaces. Show shared user and shared actor flowing through an Authorization gate to use workspace-owned resources such as Plugins, Skills, MCP Relay, and Event Sources. Show the shared remote agent differently: bridge it into the conversation as an external harness with its own runtime stack, its own tools, its own skills, and its own plugins, with example tags like Codex, Claude Code, Kimi, OpenClaw, and OpenCode. Do not depict the shared remote agent as using the current workspace's restricted plugins or skills through platform authorization. Inside MCP Relay, show Desktop, Linux Headless Server, and Mobile, and expand Desktop into CUA, Filesystem, Browser, and Command Line. Inside Event Sources, show Scheduled Jobs and Event Triggered, then split Event Triggered into Custom Webhook and Plugin-Registered Sources, with GitLab, GitHub, and Figma as common plugin examples.
```

## 第二张图的视觉重点

- 中心不是“共享对象列表”，而是“当前 workspace 的 conversation”
- share 进来的对象要被画成进入当前 conversation 的参与者
- resources 要被画成当前 workspace 的基础设施
- authorization 要被画成真正的 gate，而不是一个说明文字
- desktop relay 要最丰富，因为它最适合承载 `CUA / Filesystem / Browser / Command Line`
- event sources 要被画成 workspace-owned automation infrastructure，而不是 conversation 附件
- event sources 的分类层级要清楚到一眼能看见：`Scheduled Jobs / Event Triggered / Custom Webhook / Plugin-Registered Sources`
- `shared remote agent` 要和 `shared actor` 明显区分开
- `shared remote agent` 要像“远端完整框架”而不是“可被当前 workspace 资源授权的本地 actor”

## 这张图为什么值得单独画

第一张图回答的是：

- Synapse 的核心协作模型是什么

第二张图回答的是：

- Synapse 如何同时做到跨工作区分享与本地资源治理

这两张图连起来，会比一张大而全的图更清楚。
