"use client"

/**
 * Thin React Hook Form bindings layered over the existing shadcn `Field`
 * primitives (components/ui/field.tsx). Provides:
 *  - `Form`      — re-export of RHF's FormProvider
 *  - `FormField` — RHF Controller, with field context so children can read state
 *  - `useFormFieldError()` — returns the current field's error in the shape
 *    `FieldError` already accepts (`Array<{ message?: string }>`)
 *
 * Intentionally minimal: we keep using `Field`/`FieldLabel`/`FieldError`/`Input`
 * directly for layout, and only add the RHF wiring.
 */

import { createContext, useContext } from "react"
import {
  Controller,
  FormProvider,
  useFormContext,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"

export const Form = FormProvider

type FormFieldContextValue = {
  name: string
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null)

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  )
}

function useFormFieldName(): string {
  const ctx = useContext(FormFieldContext)
  if (!ctx) {
    throw new Error("useFormField* must be used within a <FormField>")
  }
  return ctx.name
}

/**
 * Returns the active field's error formatted for `<FieldError errors={...} />`.
 * Returns `undefined` when there is no error.
 */
export function useFormFieldError(): Array<{ message?: string }> | undefined {
  const name = useFormFieldName()
  const {
    formState: { errors },
  } = useFormContext()
  const error = errors[name]
  if (!error) return undefined
  const message = typeof error.message === "string" ? error.message : undefined
  return [{ message }]
}

/** Whether the active field currently has an error (for aria-invalid/data-invalid). */
export function useFormFieldInvalid(): boolean {
  const name = useFormFieldName()
  const {
    formState: { errors },
  } = useFormContext()
  return Boolean(errors[name])
}
