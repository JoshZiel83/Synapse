"use client"

import { useMemo, useState } from "react"
import { Plus } from "lucide-react"

import {
  buildEditableCustomDoc,
  buildEditableDocFromTemplate,
  getAvailableActorDocTemplates,
  type CoreActorDocKey,
  type EditableDoc,
} from "@/components/actor-editor-model"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

type ChoiceValue = CoreActorDocKey | "custom"

export function ActorDocCreateDialog({
  open,
  onOpenChange,
  docs,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  docs: EditableDoc[]
  onCreate: (doc: EditableDoc) => void
}) {
  const options = useMemo(() => getAvailableActorDocTemplates(docs), [docs])
  const [selectedValue, setSelectedValue] = useState<ChoiceValue | "">("")

  function handleCreate() {
    if (!selectedValue) return
    const nextDoc =
      selectedValue === "custom"
        ? buildEditableCustomDoc()
        : buildEditableDocFromTemplate(selectedValue)
    onCreate(nextDoc)
    setSelectedValue("")
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedValue("")
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add actor document</DialogTitle>
          <DialogDescription>
            Create one standard doc section or add a custom narrative slot.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup
          value={selectedValue}
          onValueChange={(value) => setSelectedValue(value as ChoiceValue)}
          className="max-h-[60vh] overflow-y-auto pr-1"
        >
          {options.map((template) => (
            <Field
              key={template.key}
              orientation="horizontal"
              className="rounded-3xl border border-border p-4"
            >
              <RadioGroupItem
                value={template.key}
                id={`actor-doc-template-${template.key}`}
              />
              <FieldContent>
                <FieldLabel htmlFor={`actor-doc-template-${template.key}`}>
                  {template.title}
                </FieldLabel>
                <FieldDescription>{template.description}</FieldDescription>
              </FieldContent>
            </Field>
          ))}

          <Field
            orientation="horizontal"
            className="rounded-3xl border border-border p-4"
          >
            <RadioGroupItem value="custom" id="actor-doc-template-custom" />
            <FieldContent>
              <FieldLabel htmlFor="actor-doc-template-custom">
                Custom
              </FieldLabel>
              <FieldDescription>
                Add a freeform section that does not map to the standard actor
                doc catalog.
              </FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!selectedValue}>
            <Plus data-icon="inline-start" />
            Add doc
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
