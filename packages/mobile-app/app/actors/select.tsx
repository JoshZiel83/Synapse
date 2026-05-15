import {
  WorkspaceEntityPickerScreen,
  WORKSPACE_ENTITY_PICKER_MODE,
} from "@/components/workspace-entity-picker-screen"

export default function ActorSelectScreen() {
  return (
    <WorkspaceEntityPickerScreen mode={WORKSPACE_ENTITY_PICKER_MODE.ACTOR} />
  )
}
