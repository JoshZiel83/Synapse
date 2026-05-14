import aiEngineerV1 from "./ai-engineer/v1.js"
import analyticsReporterV1 from "./analytics-reporter/v1.js"
import chinaEcommerceOperatorV1 from "./china-ecommerce-operator/v1.js"
import contentCreationExpertV1 from "./content-creation-expert/v1.js"
import documentGeneratorV1 from "./document-generator/v1.js"
import douyinOperatorV1 from "./douyin-operator/v1.js"
import frontendDeveloperV1 from "./frontend-developer/v1.js"
import gameDesignerV1 from "./game-designer/v1.js"
import imagePromptEngineerV1 from "./image-prompt-engineer/v1.js"
import omniSecretaryV1 from "./omni-secretary/v1.js"
import rednoteOperatorV1 from "./rednote-operator/v1.js"
import seniorDeveloperV1 from "./senior-developer/v1.js"
import seniorProjectManagerV1 from "./senior-project-manager/v1.js"
import shortVideoEditingCoachV1 from "./short-video-editing-coach/v1.js"
import softwareArchitectV1 from "./software-architect/v1.js"
import trendResearcherV1 from "./trend-researcher/v1.js"
import uiDesignerV1 from "./ui-designer/v1.js"
import wechatMiniProgramDeveloperV1 from "./wechat-mini-program-developer/v1.js"
import wechatOfficialAccountManagerV1 from "./wechat-official-account-manager/v1.js"

export {
  OFFICIAL_ACTOR_TEMPLATE_VERSION,
  type ActorCatalogRefs,
  type OfficialActorCatalogSeedResult,
  type RuntimeRefs,
} from "./shared.js"

export const DEFAULT_OFFICIAL_ACTOR_TEMPLATE_SLUG = omniSecretaryV1.slug

export const OFFICIAL_ACTOR_TEMPLATE_SEEDS = [
  omniSecretaryV1,
  seniorProjectManagerV1,
  seniorDeveloperV1,
  softwareArchitectV1,
  aiEngineerV1,
  frontendDeveloperV1,
  wechatMiniProgramDeveloperV1,
  uiDesignerV1,
  contentCreationExpertV1,
  analyticsReporterV1,
  trendResearcherV1,
  documentGeneratorV1,
  imagePromptEngineerV1,
  gameDesignerV1,
  shortVideoEditingCoachV1,
  douyinOperatorV1,
  rednoteOperatorV1,
  wechatOfficialAccountManagerV1,
  chinaEcommerceOperatorV1,
]
