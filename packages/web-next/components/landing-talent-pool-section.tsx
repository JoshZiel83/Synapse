import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { LandingReveal } from "@/components/landing-motion"
import { cn } from "@/lib/utils"

type TalentCard = {
  name: string
  role: string
  initials: string
  summary: string
  tone: string
}

const firstRowTalents: TalentCard[] = [
  { name: "Mira", role: "研究侦察员", initials: "MI", summary: "把模糊问题拆成有依据的研究结论", tone: "bg-sky-100 text-sky-950" },
  { name: "Orian", role: "推进协调员", initials: "OR", summary: "把目标拆成 owner、节点和 blocker", tone: "bg-amber-100 text-amber-950" },
  { name: "Lyra", role: "内容主笔", initials: "LY", summary: "根据你的语气快速起草对外文案", tone: "bg-cyan-100 text-cyan-950" },
  { name: "Kite", role: "数据分析师", initials: "KI", summary: "把指标波动翻译成可执行判断", tone: "bg-orange-100 text-orange-950" },
  { name: "Nora", role: "用户研究员", initials: "NO", summary: "持续记住你的用户样本和访谈偏好", tone: "bg-indigo-100 text-indigo-950" },
  { name: "Soren", role: "风险审阅官", initials: "SO", summary: "沿着你的标准补齐风险和边界提醒", tone: "bg-emerald-100 text-emerald-950" },
  { name: "Ivy", role: "项目 PMO", initials: "IV", summary: "跟住每个线程的状态、延期和责任人", tone: "bg-violet-100 text-violet-950" },
] as const

const secondRowTalents: TalentCard[] = [
  { name: "Aria", role: "品牌编辑", initials: "AR", summary: "学会你的品牌语气和表达禁区", tone: "bg-rose-100 text-rose-950" },
  { name: "Flint", role: "增长策划", initials: "FL", summary: "把增长目标拆成具体实验和动作", tone: "bg-amber-100 text-amber-950" },
  { name: "Vega", role: "产品分析师", initials: "VE", summary: "从行为信号里找出产品拐点", tone: "bg-sky-100 text-sky-950" },
  { name: "Elsa", role: "客服教练", initials: "EL", summary: "把高频问题沉淀成统一话术和 SOP", tone: "bg-cyan-100 text-cyan-950" },
  { name: "Rowan", role: "招聘助理", initials: "RO", summary: "沿着你的偏好筛人、约面、跟进", tone: "bg-orange-100 text-orange-950" },
  { name: "Quinn", role: "商务研究员", initials: "QU", summary: "快速补齐客户、市场和合作背景", tone: "bg-emerald-100 text-emerald-950" },
  { name: "Cora", role: "运营指挥", initials: "CO", summary: "让复杂协作在一条线上持续推进", tone: "bg-indigo-100 text-indigo-950" },
] as const

const thirdRowTalents: TalentCard[] = [
  { name: "Nova", role: "市场情报官", initials: "NV", summary: "持续追踪赛道变化和竞对动作", tone: "bg-sky-100 text-sky-950" },
  { name: "Theo", role: "财务参谋", initials: "TH", summary: "把数字拆成预算、风险和效率判断", tone: "bg-amber-100 text-amber-950" },
  { name: "June", role: "社媒编辑", initials: "JU", summary: "根据你的风格持续产出短内容", tone: "bg-cyan-100 text-cyan-950" },
  { name: "Sasha", role: "用户成功经理", initials: "SA", summary: "沿着用户目标持续追踪交付效果", tone: "bg-orange-100 text-orange-950" },
  { name: "Finn", role: "销售研究员", initials: "FI", summary: "会先补齐客户背景再帮你准备沟通", tone: "bg-indigo-100 text-indigo-950" },
  { name: "Lumi", role: "创意导演", initials: "LU", summary: "把你的审美偏好沉淀成创意判断", tone: "bg-emerald-100 text-emerald-950" },
  { name: "Eden", role: "CEO 助理", initials: "ED", summary: "跟住优先级、会议和关键待办", tone: "bg-violet-100 text-violet-950" },
] as const

function TalentPoolCard({ card }: { card: TalentCard }) {
  return (
    <article className="w-[var(--talent-card-width)] shrink-0 rounded-[28px] border border-white/78 bg-white/90 p-4 shadow-[0_28px_80px_-54px_rgba(15,23,42,0.42)] backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <Avatar className="size-10 ring-2 ring-white">
          <AvatarFallback className={cn("text-sm font-semibold", card.tone)}>
            {card.initials}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-slate-950">{card.name}</div>
          <div className="truncate text-sm text-slate-500">{card.role}</div>
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-700">{card.summary}</p>
    </article>
  )
}

function TalentRow({
  cards,
  shifted = false,
}: {
  cards: readonly TalentCard[]
  shifted?: boolean
}) {
  return (
    <div className="overflow-hidden">
      <div className="relative left-1/2 w-max -translate-x-1/2">
        <div
          className={cn(
            "flex gap-[var(--talent-gap)]",
            shifted && "[transform:translateX(calc((var(--talent-card-width)+var(--talent-gap))/2))]"
          )}
        >
          {cards.map((card) => (
            <TalentPoolCard key={`${card.name}-${card.role}`} card={card} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function LandingTalentPoolSection() {
  return (
    <section
      id="capabilities"
      data-landing-snap-section="true"
      className="landing-snap-section relative border-y border-border/50 bg-[linear-gradient(180deg,rgba(247,250,255,0.9),rgba(255,255,255,0.96))] py-18"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(45,212,191,0.12),transparent_34%)]" />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <LandingReveal className="mx-auto max-w-3xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
            开箱即用的人才市场
          </h2>
          <p className="mt-4 text-base leading-7 text-slate-600 sm:text-lg">
            一键招募，持续培养，自主记忆，成为独属于你的人才
          </p>
        </LandingReveal>
      </div>

      <div className="relative left-1/2 mt-12 w-screen -translate-x-1/2 overflow-hidden [--talent-card-width:15rem] [--talent-gap:1rem] sm:[--talent-card-width:16.75rem] sm:[--talent-gap:1.25rem]">
        <div className="space-y-4 sm:space-y-5">
          <LandingReveal y={24} x={-36} delay={0.06}>
            <TalentRow cards={firstRowTalents} />
          </LandingReveal>
          <LandingReveal y={24} x={36} delay={0.14}>
            <TalentRow cards={secondRowTalents} shifted />
          </LandingReveal>
          <LandingReveal y={24} x={-36} delay={0.22}>
            <TalentRow cards={thirdRowTalents} />
          </LandingReveal>
        </div>
      </div>
    </section>
  )
}
