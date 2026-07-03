"use client"

// The fixed "→ do" half: a message composer (never an action picker — our only
// action is "post a message"), a wake-actors toggle kept distinct from the
// message, and a humanized audience choice.
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { RuleDraft } from "./types"

type Delivery = RuleDraft["delivery"]
type Patch = (p: Partial<Delivery>) => void

export function DeliveryStep({
  delivery,
  patch,
  members,
}: {
  delivery: Delivery
  patch: Patch
  members: { id: string; name: string }[]
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">消息内容</Label>
        <Textarea
          value={delivery.message}
          onChange={(e) => patch({ message: e.target.value })}
          placeholder="到点/触发时，向会话里发送的消息…"
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          这条消息会出现在会话里，所有相关成员都能看到。
        </p>
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">唤醒 Actor 参与者</div>
            <p className="text-xs text-muted-foreground">
              让会话里的 Actor 被叫醒来处理，而不仅是收到消息。
            </p>
          </div>
          <Switch
            checked={delivery.wakeEnabled}
            onCheckedChange={(v) => patch({ wakeEnabled: v })}
          />
        </div>
        {delivery.wakeEnabled && (
          <div className="mt-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              唤醒理由（给 Actor 看）
            </Label>
            <Textarea
              value={delivery.wakeReason ?? ""}
              onChange={(e) => patch({ wakeReason: e.target.value })}
              placeholder="例如：生成每日数据日报"
              rows={2}
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">投递给谁</Label>
        <RadioGroup
          value={delivery.targetPolicy}
          onValueChange={(v) =>
            patch({ targetPolicy: v as Delivery["targetPolicy"] })
          }
          className="gap-2"
        >
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="all_members" />
            会话全体成员
          </label>
          <label className="flex items-center gap-2 text-sm">
            <RadioGroupItem value="specified_members" />
            指定成员
          </label>
        </RadioGroup>

        {delivery.targetPolicy === "specified_members" && (
          <div className="mt-1 space-y-1 rounded-lg border p-2">
            {members.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                选择会话后可挑选成员。
              </p>
            ) : (
              members.map((m) => {
                const on = delivery.targetParticipantIds.includes(m.id)
                return (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      on && "bg-accent/40"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        patch({
                          targetParticipantIds: e.target.checked
                            ? [...delivery.targetParticipantIds, m.id]
                            : delivery.targetParticipantIds.filter(
                                (id) => id !== m.id
                              ),
                        })
                      }
                      className="size-4 accent-primary"
                    />
                    {m.name}
                  </label>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
