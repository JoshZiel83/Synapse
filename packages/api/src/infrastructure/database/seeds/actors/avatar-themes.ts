import type { PixelArtAvatarTheme } from "../../../../modules/avatar/service.js"

const DEFAULT_SKIN_COLORS = [
  "8d5524",
  "a26d3d",
  "b68655",
  "cb9e6e",
  "e0b687",
  "eac393",
  "f5cfa0",
  "ffdbac",
]
const NATURAL_HAIR_COLORS = [
  "28150a",
  "603015",
  "612616",
  "83623b",
  "a78961",
  "cab188",
]
const FOCUSED_EYES = ["variant02", "variant05", "variant08", "variant11"]
const CALM_EYES = ["variant03", "variant06", "variant09", "variant12"]
const FRIENDLY_MOUTHS = ["happy01", "happy03", "happy06", "happy08", "happy11"]

function theme(partial: PixelArtAvatarTheme): PixelArtAvatarTheme {
  return {
    accessoriesProbability: 0,
    beardProbability: 0,
    glassesProbability: 0,
    hatProbability: 0,
    eyes: CALM_EYES,
    hairColor: NATURAL_HAIR_COLORS,
    mouth: FRIENDLY_MOUTHS,
    skinColor: DEFAULT_SKIN_COLORS,
    ...partial,
  }
}

export const OFFICIAL_ACTOR_AVATAR_THEMES: Record<string, PixelArtAvatarTheme> =
  {
    "omni-secretary": theme({
      clothing: ["variant03", "variant07", "variant10", "variant18"],
      clothingColor: ["5bc0de", "44c585", "428bca", "ffeead"],
      hair: ["long03", "long08", "long14", "short12"],
      glassesProbability: 8,
    }),
    "senior-project-manager": theme({
      clothing: ["variant02", "variant09", "variant14", "variant21"],
      clothingColor: ["03396c", "428bca", "ffc425", "ffeead"],
      hair: ["long05", "long10", "short05", "short14"],
      glasses: ["dark01", "dark03", "light02"],
      glassesColor: ["4b4b4b", "191919"],
      glassesProbability: 28,
    }),
    "senior-developer": theme({
      clothing: ["variant04", "variant07", "variant13", "variant20"],
      clothingColor: ["44c585", "428bca", "03396c"],
      hair: ["short04", "short09", "short16", "short20"],
      eyes: FOCUSED_EYES,
      beard: ["variant01", "variant03", "variant05"],
      beardProbability: 16,
      glasses: ["dark01", "dark04", "dark06"],
      glassesColor: ["4b4b4b", "43677d"],
      glassesProbability: 24,
    }),
    "software-architect": theme({
      clothing: ["variant05", "variant08", "variant15", "variant22"],
      clothingColor: ["03396c", "428bca", "989789"],
      hair: ["short06", "short11", "short17"],
      eyes: FOCUSED_EYES,
      beard: ["variant02", "variant04", "variant06"],
      beardProbability: 18,
      glasses: ["dark01", "dark02", "dark05", "light03"],
      glassesColor: ["191919", "323232"],
      glassesProbability: 72,
    }),
    "ai-engineer": theme({
      clothing: ["variant06", "variant09", "variant12", "variant23"],
      clothingColor: ["5bc0de", "428bca", "03396c"],
      hair: ["short02", "short08", "short15", "short21"],
      eyes: FOCUSED_EYES,
      glasses: ["dark02", "dark03", "light04"],
      glassesColor: ["4b4b4b", "43677d"],
      glassesProbability: 48,
    }),
    "frontend-developer": theme({
      clothing: ["variant01", "variant07", "variant11", "variant19"],
      clothingColor: ["5bc0de", "88d8b0", "428bca"],
      hair: ["long04", "long11", "short10", "short18"],
      glassesProbability: 12,
    }),
    "wechat-mini-program-developer": theme({
      clothing: ["variant02", "variant08", "variant14", "variant20"],
      clothingColor: ["00b159", "44c585", "03396c"],
      hair: ["short05", "short12", "short19"],
      eyes: FOCUSED_EYES,
      glasses: ["dark01", "light02"],
      glassesProbability: 18,
    }),
    "ui-designer": theme({
      clothing: ["variant03", "variant10", "variant16", "variant21"],
      clothingColor: ["5bc0de", "ff6f69", "ffc425", "ffeead"],
      hair: ["long06", "long12", "long18", "short13"],
      glasses: ["dark03", "light05"],
      glassesProbability: 16,
    }),
    "content-creation-expert": theme({
      clothing: ["variant04", "variant09", "variant17", "variant22"],
      clothingColor: ["ff6f69", "ffc425", "ffeead"],
      hair: ["long05", "long10", "long16", "short08"],
    }),
    "analytics-reporter": theme({
      clothing: ["variant05", "variant08", "variant15", "variant20"],
      clothingColor: ["03396c", "428bca", "5bc0de"],
      hair: ["short07", "short14", "long07"],
      eyes: FOCUSED_EYES,
      glasses: ["dark01", "dark04", "light02", "light03"],
      glassesColor: ["191919", "323232", "43677d"],
      glassesProbability: 84,
    }),
    "trend-researcher": theme({
      clothing: ["variant05", "variant11", "variant18", "variant23"],
      clothingColor: ["03396c", "ffc425", "ffeead"],
      hair: ["short06", "short15", "long09"],
      eyes: FOCUSED_EYES,
      glasses: ["dark01", "dark05", "light04"],
      glassesProbability: 68,
    }),
    "document-generator": theme({
      clothing: ["variant02", "variant06", "variant12", "variant19"],
      clothingColor: ["428bca", "5bc0de", "989789", "ffeead"],
      hair: ["short04", "short11", "long08", "long13"],
      glasses: ["dark02", "light03"],
      glassesProbability: 24,
    }),
    "image-prompt-engineer": theme({
      clothing: ["variant01", "variant10", "variant16", "variant21"],
      clothingColor: ["5bc0de", "ff6f69", "ffc425"],
      hair: ["short03", "short17", "long04", "long15"],
      glassesProbability: 10,
    }),
    "game-designer": theme({
      clothing: ["variant07", "variant13", "variant18", "variant22"],
      clothingColor: ["44c585", "428bca", "ffc425"],
      hair: ["short08", "short16", "long06"],
      beard: ["variant01", "variant04"],
      beardProbability: 10,
      glassesProbability: 8,
    }),
    "short-video-editing-coach": theme({
      clothing: ["variant03", "variant09", "variant17", "variant21"],
      clothingColor: ["ff6f69", "ffc425", "5bc0de"],
      hair: ["long07", "long14", "short09"],
      glassesProbability: 6,
    }),
    "douyin-operator": theme({
      clothing: ["variant04", "variant11", "variant18", "variant20"],
      clothingColor: ["d11141", "03396c", "ffc425"],
      hair: ["short05", "short12", "short18"],
      beard: ["variant01", "variant03"],
      beardProbability: 8,
    }),
    "rednote-operator": theme({
      clothing: ["variant02", "variant10", "variant16", "variant21"],
      clothingColor: ["ff6f69", "d11141", "ffeead"],
      hair: ["long04", "long09", "long17", "short10"],
    }),
    "wechat-official-account-manager": theme({
      clothing: ["variant03", "variant08", "variant14", "variant19"],
      clothingColor: ["00b159", "44c585", "5bc0de"],
      hair: ["long05", "long13", "short11"],
      glassesProbability: 12,
    }),
    "china-ecommerce-operator": theme({
      clothing: ["variant06", "variant12", "variant18", "variant23"],
      clothingColor: ["d11141", "ffc425", "03396c"],
      hair: ["short07", "short14", "short20"],
      beard: ["variant02", "variant04"],
      beardProbability: 10,
      glassesProbability: 14,
    }),
  }

export function getOfficialActorAvatarTheme(slug: string) {
  return (
    OFFICIAL_ACTOR_AVATAR_THEMES[slug] ||
    theme({
      clothing: ["variant03", "variant08", "variant14", "variant20"],
      clothingColor: ["5bc0de", "428bca", "44c585", "ffeead"],
      hair: ["short06", "short13", "long08", "long14"],
    })
  )
}
