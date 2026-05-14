# Synapse Framework Diagram GPT-Image-2 Prompt

## 编写依据

这版提示词不是对 Nano Banana 版本做机械改写，而是按当前 Synapse 仓库里已经能确认的产品语义重写给 `gpt-image-2`。

- `conversation` 是协作运行时真相源，IM 接入是绑定到 `conversation`，不是另起一个聊天子系统。
- 资源是独立 runtime object，授权目标明确区分 `workspace / conversation / actor / actor_in_conversation`。
- 远程代理是可分享对象，但它是外部 runtime，不等于平台原生 Actor。
- 当前项目里已落地的 remote agent runtime 以 `Claude Code` 和 `Codex CLI` 为准，不再混入仓库中没有明确实现证据的其它 runtime 标签。
- 事件源是正式系统能力，当前仓库里已经存在 `schedule`、`webhook`、`GitHub`、`GitLab`、`relay lifecycle` 这些事件面。
- 现有 web 视觉语言偏 light UI、圆角卡片、白底 + slate / sky / emerald / amber 点缀，适合直接写成 product UI mockup + systems poster。

## 推荐生成参数

根据 `.openai/image-gen-models-prompting-guide.ipynb`，这类带界面结构和小标签的图更适合按 artifact spec 来写，并优先使用横版与高质量输出。

```python
result = client.images.generate(
    model="gpt-image-2",
    prompt=prompt,
    size="1536x1024",
    quality="high",
)
```

如果首轮已经构图正确，但小标签还想更清晰，再尝试 `size="2560x1440"`；首轮不建议直接上更大的实验性尺寸。

## 主提示词

```text
Create a realistic landscape desktop product UI mockup and systems poster for a platform called "Synapse".

Goal:
Explain the real collaboration model of Synapse at a glance.
This should look like a shipped product overview visual for a launch deck, not a generic cloud architecture diagram.
Do not make it feel like abstract AI concept art.

Canvas:
16:9 landscape.
Light-mode interface.
Large centered web app window.
Rounded white cards, soft glass surfaces, subtle gradients, calm spacing, premium SaaS polish.

Main composition:
The center of the image is one current-workspace conversation inside Synapse.
The conversation is the source of truth and the main storytelling device.
Do not use floating abstract boxes as the primary structure.

Inside the same conversation thread, show these participant types coexisting:
- one Human coordinator
- one native Actor
- one Shared User arriving from another workspace
- one Shared Actor arriving from another workspace
- one Shared Remote Agent arriving from another workspace
- one External IM participant bridged in from outside the platform

Behavior cues:
- the Human is the coordinator and permission manager
- the native Actor is a platform-managed runtime, not a generic chatbot
- the Shared User and Shared Actor should visually feel imported into the current workspace but still able to work in the same thread
- the Shared Remote Agent must look different from the native Actor: it is an external harness/runtime bridged into the conversation
- the External IM participant must look like an inbound external communication endpoint, with no third-party logos

Attach a compact runtime sidecar to the native Actor with small chips or tool rows labeled:
"Loop"
"Memory"
"Skills"
"MCP Relay"
"Planning"

Attach a separate external-runtime sidecar to the Shared Remote Agent labeled:
"Own Runtime"
"Claude Code"
"Codex CLI"
"Own Tools"
"Own Skills"
"Own Plugins"

Important constraint:
Do not draw the Shared Remote Agent as consuming current-workspace restricted plugins or skills through the same authorization path as native actors.
It joins the conversation through a bridge and keeps its own runtime stack.

Workspace structure:
- left or upper-left: soft "Other Workspaces" regions
- center: "Current Workspace"
- show the Shared User, Shared Actor, and Shared Remote Agent entering the current conversation from those other workspace zones
- use tasteful bridge lines, dotted transfer lines, or participant cards crossing boundaries

Resources and authorization:
On the right side, show a workspace-owned infrastructure dock labeled "Resources".
Place a visible permission gate or control surface labeled "Authorization" between the conversation and the resource dock.
The resource dock belongs to the current workspace, not to any individual actor.

Inside "Resources", show four modules:
- "Plugins"
- "Skills"
- "MCP Relay"
- "Event Sources"

Inside "MCP Relay", show three environments:
- "Desktop"
- "Linux Headless Server"
- "Mobile"

Inside the "Desktop" relay area, show four compact tool chips:
- "CUA"
- "Filesystem"
- "Browser"
- "Command Line"

Access cues:
- draw the Human, Shared User, Shared Actor, and native Actor connecting to workspace resources only through the "Authorization" gate
- do not connect the Shared Remote Agent directly into the restricted resource dock
- make the access lines selective and governed, not wide open

Memory and context:
Show a small adjacent document-style panel near the conversation labeled "Shared Memory" and "Attached Context".
It should feel like durable conversation context, not random floating notes or detached database nodes.

Events:
From the top edge or upper-right, show event flows entering the current workspace runtime.
Inside "Event Sources", show:
- "Scheduled Jobs"
- "Webhook"
- "GitHub"
- "GitLab"
- "Relay Online"
- "Relay Offline"

These event flows should visually feed into the same current-workspace conversation runtime and wake collaboration.

Text rendering constraints:
Use crisp, legible sans-serif UI typography.
Render only short labels.
Do not add paragraphs, marketing copy, lorem ipsum, or extra explanatory text.
Do not add brand logos, mascots, or unrelated trademarks.

Allowed visible labels only:
"Synapse"
"Current Workspace"
"Other Workspaces"
"Conversation"
"Human"
"Actor"
"Shared User"
"Shared Actor"
"Shared Remote Agent"
"External IM"
"Loop"
"Memory"
"Skills"
"MCP Relay"
"Planning"
"Own Runtime"
"Claude Code"
"Codex CLI"
"Own Tools"
"Own Skills"
"Own Plugins"
"Authorization"
"Resources"
"Plugins"
"Desktop"
"Linux Headless Server"
"Mobile"
"CUA"
"Filesystem"
"Browser"
"Command Line"
"Event Sources"
"Scheduled Jobs"
"Webhook"
"GitHub"
"GitLab"
"Relay Online"
"Relay Offline"
"Shared Memory"
"Attached Context"

Visual style:
Realistic product UI mockup, premium SaaS overview poster, not illustration-heavy concept art.
Use the actual Synapse visual direction: light mode, slate base, sky-blue accents, emerald highlights, amber accents, white cards, rounded 24px to 32px corners, subtle shadow layers, high information clarity.
The image should feel calm, operational, precise, and premium.

Avoid:
traditional cloud architecture diagrams, server racks, kubernetes icons, database cylinders, giant arrows everywhere, dark cyberpunk styling, logo soup, dense text blocks, unrelated charts, phone mockups, hand-drawn illustration, comic style.
```

## 更稳的简化版

如果第一版因为标签过多而显得拥挤，可以先用这一版打首轮构图，再逐步补细节：

```text
Create a polished landscape product systems visual for "Synapse" that looks like a real desktop SaaS interface, not a cloud architecture diagram.

Center the image on one "Current Workspace" conversation.
Inside the same thread, show "Human", "Actor", "Shared User", "Shared Actor", "Shared Remote Agent", and "External IM" as first-class participants.

Show the native "Actor" with a small runtime panel containing "Loop", "Memory", "Skills", "MCP Relay", and "Planning".
Show the "Shared Remote Agent" differently: bridge it into the conversation with its own sidecar labeled "Own Runtime", "Claude Code", "Codex CLI", "Own Tools", "Own Skills", and "Own Plugins".
Do not show the Shared Remote Agent using the current workspace resource dock through the same authorization path as native actors.

On the right side, show a workspace-owned dock labeled "Resources" with "Plugins", "Skills", "MCP Relay", and "Event Sources".
Place an "Authorization" gate between the conversation and the resource dock.
Inside "MCP Relay", show "Desktop", "Linux Headless Server", "Mobile", and under Desktop show "CUA", "Filesystem", "Browser", and "Command Line".
Inside "Event Sources", show "Scheduled Jobs", "Webhook", "GitHub", "GitLab", "Relay Online", and "Relay Offline".

Add a small panel labeled "Shared Memory" and "Attached Context" near the conversation.
Use light mode, white cards, slate / sky / emerald / amber accents, rounded corners, soft shadows, and crisp sans-serif UI typography.
Render only the labels listed above and no extra text.
```

## 取舍说明

- 没有继续沿用 `Kimi / OpenCode / OpenClaw / Figma` 这些旧文档里的示例标签，因为当前仓库里对 remote runtime 和 event source 的直接实现证据不够统一，放进去会削弱“基于项目本身”的准确性。
- 把主图收敛为 `current workspace conversation + workspace-owned resources + authorization + cross-workspace sharing + event wakeups` 这一个场景，是因为这比“传统架构图拼贴”更符合 Synapse 当前产品与运行时设计。
