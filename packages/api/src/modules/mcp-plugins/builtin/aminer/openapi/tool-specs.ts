import { createHmac } from "node:crypto"
import { ToolDefinition } from "@synapse/shared"

type JsonObject = Record<string, unknown>
type QueryEntry = [string, string]
type ToolParamType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "string_array"
  | "number_array"
  | "string_matrix"

interface ToolParamSpec {
  name: string
  type: ToolParamType
  description: string
  required?: boolean
  enum?: Array<string | number>
  minimum?: number
  maximum?: number
}

interface AminerToolSpec {
  name: string
  description: string
  method: "GET" | "POST"
  path: string
  params: ToolParamSpec[]
  stream?: boolean
  buildRequest: (input: JsonObject) => {
    body?: JsonObject
    query?: QueryEntry[]
  }
  formatResult: (result: JsonObject | string) => string
}

class AminerApiError extends Error {
  code?: number
  isAuthError: boolean

  constructor(
    message: string,
    options?: { code?: number; isAuthError?: boolean }
  ) {
    super(message)
    this.name = "AminerApiError"
    this.code = options?.code
    this.isAuthError = options?.isAuthError === true
  }
}

const AMINER_API_BASE = "https://datacenter.aminer.cn/gateway/open_platform/api"
const DEFAULT_TIMEOUT_MS = 60_000
const DISPLAY_ITEM_LIMIT = 20
const PAPER_SORT_OPTIONS = ["year", "n_citation"]
const DEEP_RESEARCH_CORPUS_TYPES = [1, 2, 3]

function buildToolDefinition(spec: AminerToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const param of spec.params) {
    const property: Record<string, unknown> = {
      description: param.description,
    }
    switch (param.type) {
      case "string":
        property.type = "string"
        break
      case "integer":
        property.type = "integer"
        break
      case "number":
        property.type = "number"
        break
      case "boolean":
        property.type = "boolean"
        break
      case "string_array":
        property.type = "array"
        property.items = { type: "string" }
        break
      case "number_array":
        property.type = "array"
        property.items = { type: "number" }
        break
      case "string_matrix":
        property.type = "array"
        property.items = {
          type: "array",
          items: { type: "string" },
        }
        break
      default:
        property.type = "string"
        break
    }
    if (param.enum?.length) property.enum = param.enum
    if (param.minimum !== undefined) property.minimum = param.minimum
    if (param.maximum !== undefined) property.maximum = param.maximum
    properties[param.name] = property
    if (param.required) required.push(param.name)
  }

  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: "object",
      properties: properties as ToolDefinition["parameters"]["properties"],
      required,
    },
  }
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function htmlToText(value: string) {
  return compactWhitespace(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
}

function stringifyClipped(value: unknown, maxChars = 3000) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...truncated...`
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function firstItem(value: unknown) {
  if (Array.isArray(value)) return value[0]
  return value
}

function firstNonEmpty(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value))
      return String(value)
  }
  return undefined
}

function readOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readRequiredString(input: JsonObject, key: string, label: string) {
  const value = readOptionalString(input[key])
  if (!value) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function readOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function readOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readInteger(
  value: unknown,
  options?: {
    defaultValue?: number
    min?: number
    max?: number
  }
) {
  const parsed = readOptionalNumber(value)
  const fallback = options?.defaultValue
  const base = parsed === undefined ? fallback : Math.trunc(parsed)
  if (base === undefined) return undefined
  let next = base
  if (options?.min !== undefined) next = Math.max(options.min, next)
  if (options?.max !== undefined) next = Math.min(options.max, next)
  return next
}

function readStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => readOptionalString(item))
      .filter((item): item is string => Boolean(item))
  }
  const single = readOptionalString(value)
  return single ? [single] : []
}

function readNumberArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => readOptionalNumber(item))
    .filter((item): item is number => item !== undefined)
}

function readStringMatrix(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  if (!Array.isArray(value)) return []
  return value
    .map((group) =>
      Array.isArray(group)
        ? group
            .map((item) => readOptionalString(item))
            .filter((item): item is string => Boolean(item))
        : []
    )
    .filter((group) => group.length > 0)
}

function requireAtLeastOne(values: Array<unknown>, message: string) {
  const ok = values.some((value) => {
    if (typeof value === "string") return value.trim().length > 0
    if (typeof value === "number") return Number.isFinite(value)
    if (Array.isArray(value)) return value.length > 0
    return Boolean(value)
  })
  if (!ok) throw new Error(message)
}

function dedupe(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)))
}

function appendQueryEntry(entries: QueryEntry[], key: string, value: unknown) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryEntry(entries, key, item)
    }
    return
  }
  if (typeof value === "boolean") {
    entries.push([key, value ? "true" : "false"])
    return
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    entries.push([key, String(value)])
    return
  }
  if (typeof value === "string" && value.trim()) {
    entries.push([key, value.trim()])
  }
}

function cleanTextValue(value: unknown) {
  const text = firstNonEmpty(value)
  return text ? htmlToText(text) : undefined
}

function summarizeArray(
  value: unknown,
  options?: {
    limit?: number
    extractor?: (item: unknown) => string | undefined
  }
) {
  const items = asArray<unknown>(value)
  const limit = options?.limit ?? 5
  const values = items
    .map((item) => {
      if (options?.extractor) return options.extractor(item)
      if (typeof item === "string") return compactWhitespace(item)
      if (typeof item === "number") return String(item)
      const object = asObject(item)
      return firstNonEmpty(
        object.name_zh,
        object.name,
        object.title_zh,
        object.title,
        object.raw_zh,
        object.raw,
        object.id
      )
    })
    .filter((item): item is string => Boolean(item))
  if (values.length === 0) return undefined
  const clipped = values.slice(0, limit).join(", ")
  return values.length > limit ? `${clipped} ...` : clipped
}

function formatSection(title: string, lines: Array<string | null | undefined>) {
  const filtered = lines.filter((line): line is string => Boolean(line))
  if (filtered.length === 0) return undefined
  return `${title}:\n${filtered.join("\n")}`
}

function finalizeOutput(
  title: string,
  sections: Array<string | null | undefined>,
  result?: JsonObject
) {
  const blocks = [
    title,
    ...sections.filter((section): section is string => Boolean(section)),
  ]
  const logId = cleanTextValue(result?.log_id)
  if (logId) blocks.push(`Log ID: ${logId}`)
  return blocks.join("\n\n")
}

function resolveTotal(result: JsonObject, items: unknown[]) {
  const direct = readOptionalNumber(result.total)
  if (direct !== undefined) return direct
  const first = asObject(items[0])
  return readOptionalNumber(first.total)
}

function renderScholarItem(item: unknown, index: number) {
  const scholar = asObject(item)
  return [
    `${index + 1}. ${firstNonEmpty(scholar.name_zh, scholar.name, scholar.id) || "Scholar"}`,
    firstNonEmpty(scholar.id) ? `ID: ${firstNonEmpty(scholar.id)}` : null,
    firstNonEmpty(scholar.org_zh, scholar.org)
      ? `Organization: ${firstNonEmpty(scholar.org_zh, scholar.org)}`
      : null,
    readOptionalNumber(scholar.n_citation) !== undefined
      ? `Citations: ${readOptionalNumber(scholar.n_citation)}`
      : null,
    summarizeArray(scholar.interests)
      ? `Interests: ${summarizeArray(scholar.interests, { limit: 6 })}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderPaperItem(item: unknown, index: number) {
  const paper = asObject(item)
  const authors = summarizeArray(paper.authors, {
    limit: 6,
    extractor: (author) => {
      const authorObject = asObject(author)
      return firstNonEmpty(authorObject.name_zh, authorObject.name)
    },
  })
  const venue = firstNonEmpty(
    asObject(paper.venue).name_zh,
    asObject(paper.venue).name_en,
    asObject(paper.venue).raw_zh,
    asObject(paper.venue).raw,
    paper.raw
  )

  return [
    `${index + 1}. ${firstNonEmpty(paper.title_zh, paper.title, paper.id) || "Paper"}`,
    firstNonEmpty(paper.id, paper._id)
      ? `ID: ${firstNonEmpty(paper.id, paper._id)}`
      : null,
    firstNonEmpty(paper.doi) ? `DOI: ${firstNonEmpty(paper.doi)}` : null,
    readOptionalNumber(paper.year) !== undefined
      ? `Year: ${readOptionalNumber(paper.year)}`
      : null,
    venue ? `Venue: ${venue}` : null,
    authors ? `Authors: ${authors}` : null,
    readOptionalNumber(paper.n_citation) !== undefined
      ? `Citations: ${readOptionalNumber(paper.n_citation)}`
      : null,
    summarizeArray(paper.keywords, { limit: 6 })
      ? `Keywords: ${summarizeArray(paper.keywords, { limit: 6 })}`
      : null,
    summarizeArray(paper.keywords_zh, { limit: 6 })
      ? `Chinese keywords: ${summarizeArray(paper.keywords_zh, { limit: 6 })}`
      : null,
    cleanTextValue(paper.url) ? `URL: ${cleanTextValue(paper.url)}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderPatentItem(item: unknown, index: number) {
  const patent = asObject(item)
  return [
    `${index + 1}. ${firstNonEmpty(patent.title, patent.title_zh, patent.id) || "Patent"}`,
    firstNonEmpty(patent.id) ? `ID: ${firstNonEmpty(patent.id)}` : null,
    firstNonEmpty(patent.patent_no, patent.number, patent.application_no)
      ? `Patent No: ${firstNonEmpty(patent.patent_no, patent.number, patent.application_no)}`
      : null,
    firstNonEmpty(patent.country)
      ? `Country: ${firstNonEmpty(patent.country)}`
      : null,
    cleanTextValue(patent.abstract)
      ? `Abstract: ${cleanTextValue(patent.abstract)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderOrganizationItem(item: unknown, index: number) {
  const organization = asObject(item)
  return [
    `${index + 1}. ${firstNonEmpty(organization.org_name, organization.name_zh, organization.name_en, organization.name, organization.id) || "Organization"}`,
    firstNonEmpty(organization.org_id, organization.id)
      ? `ID: ${firstNonEmpty(organization.org_id, organization.id)}`
      : null,
    summarizeArray(organization.aliases, { limit: 5 })
      ? `Aliases: ${summarizeArray(organization.aliases, { limit: 5 })}`
      : null,
    summarizeArray(organization.acronyms, { limit: 5 })
      ? `Acronyms: ${summarizeArray(organization.acronyms, { limit: 5 })}`
      : null,
    firstNonEmpty(organization.type)
      ? `Type: ${firstNonEmpty(organization.type)}`
      : null,
    cleanTextValue(organization.location)
      ? `Location: ${cleanTextValue(organization.location)}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderVenueItem(item: unknown, index: number) {
  const venue = asObject(item)
  return [
    `${index + 1}. ${firstNonEmpty(venue.name_zh, venue.name_en, venue.raw, venue.id) || "Venue"}`,
    firstNonEmpty(venue.id) ? `ID: ${firstNonEmpty(venue.id)}` : null,
    firstNonEmpty(venue.issn) ? `ISSN: ${firstNonEmpty(venue.issn)}` : null,
    firstNonEmpty(venue.type) ? `Type: ${firstNonEmpty(venue.type)}` : null,
    summarizeArray(venue.alias, { limit: 5 })
      ? `Aliases: ${summarizeArray(venue.alias, { limit: 5 })}`
      : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function renderProjectItem(item: unknown, index: number) {
  const project = asObject(item)
  const titles = Array.isArray(project.titles)
    ? project.titles
        .map((title) => {
          const titleObject = asObject(title)
          return firstNonEmpty(
            titleObject.title_zh,
            titleObject.title,
            titleObject.name
          )
        })
        .filter((title): title is string => Boolean(title))
    : []

  return [
    `${index + 1}. ${titles[0] || firstNonEmpty(project.id) || "Project"}`,
    firstNonEmpty(project.id) ? `ID: ${firstNonEmpty(project.id)}` : null,
    titles.length > 1
      ? `Additional titles: ${titles.slice(1, 4).join(", ")}`
      : null,
    firstNonEmpty(project.project_source)
      ? `Source: ${firstNonEmpty(project.project_source)}`
      : null,
    firstNonEmpty(project.country)
      ? `Country: ${firstNonEmpty(project.country)}`
      : null,
    firstNonEmpty(project.start_date, project.end_date)
      ? `Dates: ${firstNonEmpty(project.start_date) || "?"} -> ${firstNonEmpty(project.end_date) || "?"}`
      : null,
    firstNonEmpty(project.fund_amount)
      ? `Funding: ${firstNonEmpty(project.fund_amount)} ${firstNonEmpty(project.fund_currency) || ""}`.trim()
      : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function formatListResult(
  title: string,
  result: JsonObject,
  renderer: (item: unknown, index: number) => string
) {
  const items = asArray<unknown>(result.data)
  const shown = items.slice(0, DISPLAY_ITEM_LIMIT)
  const total = resolveTotal(result, items)
  const sections: Array<string | null | undefined> = [
    typeof total === "number"
      ? `Total results: ${total}`
      : `Returned results: ${items.length}`,
    items.length > DISPLAY_ITEM_LIMIT
      ? `Showing first ${DISPLAY_ITEM_LIMIT} items from the current response payload.`
      : null,
    shown.length > 0
      ? shown.map((item, index) => renderer(item, index)).join("\n\n")
      : "No results returned.",
  ]
  return finalizeOutput(title, sections, result)
}

function formatScholarDetail(result: JsonObject) {
  const scholar = asObject(firstItem(result.data))
  const honorItems = asArray<unknown>(scholar.honor)
    .slice(0, 8)
    .map((item) => {
      const honor = asObject(item)
      const award = firstNonEmpty(honor.award)
      const year = firstNonEmpty(honor.year)
      const reason = cleanTextValue(honor.reason)
      return [award, year ? `(${year})` : null, reason ? `- ${reason}` : null]
        .filter(Boolean)
        .join(" ")
    })
    .filter(Boolean)

  const sections = [
    formatSection("Scholar", [
      `Name: ${firstNonEmpty(scholar.name_zh, scholar.name, scholar.id) || "Unknown"}`,
      firstNonEmpty(scholar.id) ? `ID: ${firstNonEmpty(scholar.id)}` : null,
      firstNonEmpty(scholar.position_zh, scholar.position)
        ? `Position: ${firstNonEmpty(scholar.position_zh, scholar.position)}`
        : null,
      summarizeArray(scholar.org_zhs, { limit: 4 }) ||
      summarizeArray(scholar.orgs, { limit: 4 })
        ? `Organizations: ${summarizeArray(scholar.org_zhs, { limit: 4 }) || summarizeArray(scholar.orgs, { limit: 4 })}`
        : null,
    ]),
    cleanTextValue(scholar.bio_zh || scholar.bio)
      ? `Biography:\n${cleanTextValue(scholar.bio_zh || scholar.bio)}`
      : null,
    cleanTextValue(scholar.edu_zh || scholar.edu)
      ? `Education:\n${cleanTextValue(scholar.edu_zh || scholar.edu)}`
      : null,
    honorItems.length > 0
      ? `Honors:\n${honorItems.map((item) => `- ${item}`).join("\n")}`
      : null,
  ]

  if (sections.every((item) => !item)) {
    sections.push(`Raw response:\n${stringifyClipped(scholar)}`)
  }
  return finalizeOutput("Scholar detail", sections, result)
}

function formatScholarProfile(result: JsonObject) {
  const profile = asObject(firstItem(result.data))
  const sections = [
    formatSection("Scholar profile", [
      firstNonEmpty(profile.id)
        ? `Scholar ID: ${firstNonEmpty(profile.id)}`
        : null,
      summarizeArray(profile.interests, { limit: 12 })
        ? `Interests: ${summarizeArray(profile.interests, { limit: 12 })}`
        : null,
      summarizeArray(profile.domain, { limit: 8 })
        ? `Domains: ${summarizeArray(profile.domain, { limit: 8 })}`
        : null,
      summarizeArray(profile.research_fields, { limit: 8 })
        ? `Research fields: ${summarizeArray(profile.research_fields, { limit: 8 })}`
        : null,
    ]),
    Object.keys(profile).length > 0
      ? `Raw profile excerpt:\n${stringifyClipped(profile)}`
      : null,
  ]
  return finalizeOutput("Scholar profile", sections, result)
}

function formatPaperDetail(result: JsonObject) {
  const paper = asObject(firstItem(result.data))
  const authors = asArray<unknown>(paper.authors)
    .slice(0, 10)
    .map((item) => {
      const author = asObject(item)
      const name = firstNonEmpty(author.name_zh, author.name)
      const org = firstNonEmpty(author.org_zh, author.org, author.org_name)
      return [name, org ? `(${org})` : null].filter(Boolean).join(" ")
    })
    .filter(Boolean)
  const sections = [
    formatSection("Paper", [
      `Title: ${firstNonEmpty(paper.title_zh, paper.title, paper.id) || "Unknown"}`,
      firstNonEmpty(paper.id) ? `ID: ${firstNonEmpty(paper.id)}` : null,
      firstNonEmpty(paper.doi) ? `DOI: ${firstNonEmpty(paper.doi)}` : null,
      readOptionalNumber(paper.year) !== undefined
        ? `Year: ${readOptionalNumber(paper.year)}`
        : null,
      firstNonEmpty(
        asObject(paper.venue).name_zh,
        asObject(paper.venue).name_en,
        asObject(paper.venue).raw_zh,
        asObject(paper.venue).raw,
        paper.raw
      )
        ? `Venue: ${firstNonEmpty(
            asObject(paper.venue).name_zh,
            asObject(paper.venue).name_en,
            asObject(paper.venue).raw_zh,
            asObject(paper.venue).raw,
            paper.raw
          )}`
        : null,
      firstNonEmpty(paper.issn) ? `ISSN: ${firstNonEmpty(paper.issn)}` : null,
      firstNonEmpty(paper.issue, paper.volume)
        ? `Volume/Issue: ${firstNonEmpty(paper.volume) || "?"} / ${firstNonEmpty(paper.issue) || "?"}`
        : null,
    ]),
    authors.length > 0
      ? `Authors:\n${authors.map((item) => `- ${item}`).join("\n")}`
      : null,
    summarizeArray(paper.keywords, { limit: 12 })
      ? `Keywords: ${summarizeArray(paper.keywords, { limit: 12 })}`
      : null,
    summarizeArray(paper.keywords_zh, { limit: 12 })
      ? `Chinese keywords: ${summarizeArray(paper.keywords_zh, { limit: 12 })}`
      : null,
    cleanTextValue(paper.abstract_zh || paper.abstract)
      ? `Abstract:\n${cleanTextValue(paper.abstract_zh || paper.abstract)}`
      : null,
  ]
  if (sections.every((item) => !item)) {
    sections.push(`Raw response:\n${stringifyClipped(paper)}`)
  }
  return finalizeOutput("Paper detail", sections, result)
}

function formatPatentDetail(result: JsonObject) {
  const patent = asObject(firstItem(result.data))
  const sections = [
    formatSection("Patent", [
      `Title: ${firstNonEmpty(patent.title_zh, patent.title, patent.id) || "Unknown"}`,
      firstNonEmpty(patent.id) ? `ID: ${firstNonEmpty(patent.id)}` : null,
      firstNonEmpty(patent.patent_no, patent.number, patent.application_no)
        ? `Patent No: ${firstNonEmpty(patent.patent_no, patent.number, patent.application_no)}`
        : null,
      firstNonEmpty(patent.country)
        ? `Country: ${firstNonEmpty(patent.country)}`
        : null,
      firstNonEmpty(patent.apply_date, patent.application_date)
        ? `Application date: ${firstNonEmpty(patent.apply_date, patent.application_date)}`
        : null,
      firstNonEmpty(patent.public_date, patent.publication_date)
        ? `Publication date: ${firstNonEmpty(patent.public_date, patent.publication_date)}`
        : null,
      summarizeArray(patent.inventors, {
        limit: 8,
        extractor: (inventor) => {
          const inventorObject = asObject(inventor)
          return firstNonEmpty(inventorObject.name_zh, inventorObject.name)
        },
      })
        ? `Inventors: ${summarizeArray(patent.inventors, {
            limit: 8,
            extractor: (inventor) => {
              const inventorObject = asObject(inventor)
              return firstNonEmpty(inventorObject.name_zh, inventorObject.name)
            },
          })}`
        : null,
    ]),
    cleanTextValue(patent.abstract_zh || patent.abstract)
      ? `Abstract:\n${cleanTextValue(patent.abstract_zh || patent.abstract)}`
      : null,
    Object.keys(patent).length > 0
      ? `Raw detail excerpt:\n${stringifyClipped(patent)}`
      : null,
  ]
  return finalizeOutput("Patent detail", sections, result)
}

function formatOrganizationDetails(result: JsonObject) {
  return formatListResult(
    "Organization details",
    result,
    renderOrganizationItem
  )
}

function formatVenueDetail(result: JsonObject) {
  const venue = asObject(firstItem(result.data))
  const sections = [
    formatSection("Venue", [
      `Name: ${firstNonEmpty(venue.name_zh, venue.name_en, venue.raw, venue.id) || "Unknown"}`,
      firstNonEmpty(venue.id) ? `ID: ${firstNonEmpty(venue.id)}` : null,
      firstNonEmpty(venue.issn) ? `ISSN: ${firstNonEmpty(venue.issn)}` : null,
      firstNonEmpty(venue.type) ? `Type: ${firstNonEmpty(venue.type)}` : null,
      summarizeArray(venue.alias, { limit: 8 })
        ? `Aliases: ${summarizeArray(venue.alias, { limit: 8 })}`
        : null,
    ]),
    Object.keys(venue).length > 0
      ? `Raw detail excerpt:\n${stringifyClipped(venue)}`
      : null,
  ]
  return finalizeOutput("Venue detail", sections, result)
}

function formatDeepResearchResult(result: JsonObject | string) {
  const rawText = typeof result === "string" ? result : JSON.stringify(result)
  const events = parseSseEvents(rawText)
  if (events.length === 0) {
    if (typeof result === "string") {
      return finalizeOutput("Deep academic research", [result])
    }
    return finalizeOutput(
      "Deep academic research",
      [`Raw response:\n${stringifyClipped(result)}`],
      result
    )
  }

  const thoughtChunks: string[] = []
  const answerChunks: string[] = []
  let requestId: string | undefined
  let status: string | undefined

  for (const event of events) {
    const payload = asObject(event)
    requestId = firstNonEmpty(requestId, payload.request_id, payload.id)
    status = firstNonEmpty(payload.status, status)
    const content = cleanTextValue(payload.content)
    if (!content) continue
    if (String(payload.content_type || "").toLowerCase() === "think") {
      thoughtChunks.push(content)
    } else {
      answerChunks.push(content)
    }
  }

  const sections = [
    requestId ? `Request ID: ${requestId}` : null,
    status ? `Final status: ${status}` : null,
    thoughtChunks.length > 0
      ? `Thinking trace:\n${thoughtChunks.join("\n")}`
      : null,
    answerChunks.length > 0 ? `Answer:\n${answerChunks.join("\n")}` : null,
  ]
  return finalizeOutput("Deep academic research", sections)
}

function parseSseEvents(rawText: string) {
  const events: unknown[] = []
  const lines = rawText.split(/\r?\n/)
  let dataLines: string[] = []

  const flush = () => {
    if (dataLines.length === 0) return
    const payload = dataLines.join("\n").trim()
    dataLines = []
    if (!payload || payload === "[DONE]") return
    try {
      events.push(JSON.parse(payload))
    } catch {
      events.push({ content: payload, content_type: "text" })
    }
  }

  for (const line of lines) {
    if (line.startsWith("data:")) {
      const chunk = line.slice(5)
      dataLines.push(chunk.startsWith(" ") ? chunk.slice(1) : chunk)
      continue
    }
    if (!line.trim()) {
      flush()
    }
  }
  flush()
  return events
}

function parseJsonMaybe(value: string) {
  try {
    return JSON.parse(value) as JsonObject
  } catch {
    return undefined
  }
}

function buildAuthCandidates(token: string) {
  const trimmed = token.trim()
  const candidates = [trimmed]
  if (!/^Token\s+/i.test(trimmed)) candidates.push(`Token ${trimmed}`)
  if (!/^Bearer\s+/i.test(trimmed)) candidates.push(`Bearer ${trimmed}`)
  return dedupe(candidates)
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url")
}

function signAminerJwt(input: {
  apiKey: string
  userId: string
  ttlSeconds: number
}) {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: "HS256",
    sign_type: "SIGN",
  }
  const payload = {
    user_id: input.userId,
    exp: now + input.ttlSeconds,
    timestamp: now,
  }
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac("sha256", input.apiKey)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
  return `${signingInput}.${signature}`
}

function isAuthErrorCode(code?: number, message?: string) {
  if (code === 401 || code === 403 || code === 40308) return true
  const text = (message || "").toLowerCase()
  return text.includes("token") || text.includes("authorization")
}

function getConfiguredToken(config: JsonObject) {
  const apiKey = readOptionalString(config.apiKey)
  const userId = readOptionalString(config.userId)
  if (apiKey && userId) {
    const ttlSeconds =
      readInteger(config.tokenTtlSeconds, {
        defaultValue: 7200,
        min: 60,
        max: 86_400,
      }) || 7200
    return signAminerJwt({
      apiKey,
      userId,
      ttlSeconds,
    })
  }

  const token =
    readOptionalString(config.apiToken) ||
    readOptionalString(config.accessToken) ||
    readOptionalString(config.token)
  if (!token) {
    throw new Error(
      "AMiner credentials not configured. Set apiKey + userId, or provide apiToken as a fallback."
    )
  }
  return token
}

async function fetchAminer(
  spec: AminerToolSpec,
  input: JsonObject,
  config: JsonObject
): Promise<JsonObject | string> {
  const token = getConfiguredToken(config)
  const timeoutMs =
    readInteger(config.timeoutMs, {
      defaultValue: DEFAULT_TIMEOUT_MS,
      min: 5_000,
      max: 180_000,
    }) || DEFAULT_TIMEOUT_MS
  const request = spec.buildRequest(input)
  const query = new URLSearchParams()
  for (const [key, value] of request.query || []) {
    query.append(key, value)
  }
  const url = `${AMINER_API_BASE}${spec.path}${query.toString() ? `?${query.toString()}` : ""}`
  let lastError: unknown

  for (const authValue of buildAuthCandidates(token)) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: spec.method,
        headers: {
          Authorization: authValue,
          ...(spec.method === "POST"
            ? { "Content-Type": "application/json;charset=utf-8" }
            : {}),
        },
        body:
          spec.method === "POST"
            ? JSON.stringify(request.body || {})
            : undefined,
        signal: controller.signal,
      })
      const text = await response.text()
      const parsed = parseJsonMaybe(text)

      if (!response.ok) {
        const message =
          (parsed && firstNonEmpty(parsed.msg, parsed.message, parsed.error)) ||
          text ||
          `HTTP ${response.status}`
        throw new AminerApiError(
          `AMiner ${spec.name} failed with HTTP ${response.status}: ${message}`,
          {
            code: response.status,
            isAuthError: isAuthErrorCode(response.status, String(message)),
          }
        )
      }

      if (
        spec.stream ||
        (response.headers.get("content-type") || "").includes(
          "text/event-stream"
        )
      ) {
        if (parsed && parsed.success === false) {
          throw new AminerApiError(
            `AMiner ${spec.name} failed (${readOptionalNumber(parsed.code) || "unknown"}): ${firstNonEmpty(parsed.msg, parsed.message) || "Unknown error"}`,
            {
              code: readInteger(parsed.code),
              isAuthError: isAuthErrorCode(
                readInteger(parsed.code),
                firstNonEmpty(parsed.msg, parsed.message)
              ),
            }
          )
        }
        return text
      }

      if (!parsed) {
        throw new AminerApiError(
          `AMiner ${spec.name} returned a non-JSON response.`
        )
      }

      if (
        parsed.success === false ||
        (parsed.code !== undefined && Number(parsed.code) !== 200)
      ) {
        const code = readInteger(parsed.code)
        const message =
          firstNonEmpty(parsed.msg, parsed.message) || "Unknown error"
        throw new AminerApiError(
          `AMiner ${spec.name} failed (${code || "unknown"}): ${message}`,
          {
            code,
            isAuthError: isAuthErrorCode(code, message),
          }
        )
      }

      return parsed
    } catch (error) {
      lastError = error
      if (
        error instanceof AminerApiError &&
        error.isAuthError &&
        authValue !== buildAuthCandidates(token).slice(-1)[0]
      ) {
        continue
      }
      if (error instanceof Error && controller.signal.aborted) {
        throw new Error(`AMiner ${spec.name} timed out after ${timeoutMs} ms.`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`AMiner ${spec.name} request failed.`)
}

function buildScholarSearchRequest(input: JsonObject) {
  const name = readOptionalString(input.name)
  const organization = readOptionalString(input.organization || input.org)
  const organizationIds = dedupe([
    ...readStringArray(input.organizationIds),
    ...readStringArray(input.organizationId),
    ...readStringArray(input.orgIds),
    ...readStringArray(input.orgId),
  ])
  requireAtLeastOne(
    [name, organization, organizationIds],
    "Provide at least one of name, organization, or organizationIds."
  )
  const body: JsonObject = {
    offset: readInteger(input.offset, { defaultValue: 0, min: 0 }) || 0,
    size:
      readInteger(input.limit || input.size, {
        defaultValue: 10,
        min: 1,
        max: 10,
      }) || 10,
  }
  if (name) body.name = name
  if (organization) body.org = organization
  if (organizationIds.length > 0) body.org_id = organizationIds
  return { body }
}

function buildSingleIdQuery(
  input: JsonObject,
  sourceKey: string,
  targetKey = "id",
  label = "ID"
) {
  const id = readRequiredString(input, sourceKey, label)
  return { query: [[targetKey, id]] as QueryEntry[] }
}

function buildSingleIdBody(
  input: JsonObject,
  sourceKey: string,
  targetKey = "id",
  label = "ID"
) {
  const id = readRequiredString(input, sourceKey, label)
  return { body: { [targetKey]: id } }
}

function buildPaperSearchByTitleRequest(input: JsonObject) {
  const title = readRequiredString(input, "title", "Paper title")
  return {
    query: [
      ["title", title],
      [
        "page",
        String(readInteger(input.page, { defaultValue: 1, min: 1 }) || 1),
      ],
      [
        "size",
        String(
          readInteger(input.size || input.limit, {
            defaultValue: 10,
            min: 1,
            max: 100,
          }) || 10
        ),
      ],
    ] as QueryEntry[],
  }
}

function buildPaperSearchAdvancedRequest(input: JsonObject) {
  const title = readOptionalString(input.title)
  const keyword = readOptionalString(input.keyword)
  const abstractText = readOptionalString(input.abstractText || input.abstract)
  const author = readOptionalString(input.author)
  const organization = readOptionalString(input.organization || input.org)
  const venue = readOptionalString(input.venue)
  requireAtLeastOne(
    [title, keyword, abstractText, author, organization, venue],
    "Provide at least one of title, keyword, abstractText, author, organization, or venue."
  )
  const query: QueryEntry[] = [
    ["page", String(readInteger(input.page, { defaultValue: 1, min: 1 }) || 1)],
    [
      "size",
      String(
        readInteger(input.size || input.limit, {
          defaultValue: 10,
          min: 1,
          max: 100,
        }) || 10
      ),
    ],
  ]
  appendQueryEntry(query, "title", title)
  appendQueryEntry(query, "keyword", keyword)
  appendQueryEntry(query, "abstract", abstractText)
  appendQueryEntry(query, "author", author)
  appendQueryEntry(query, "org", organization)
  appendQueryEntry(query, "venue", venue)
  const sortBy = readOptionalString(input.sortBy || input.order)
  if (sortBy && PAPER_SORT_OPTIONS.includes(sortBy)) {
    appendQueryEntry(query, "order", sortBy)
  }
  return { query }
}

function buildPaperSearchRequest(input: JsonObject) {
  const keyword = readOptionalString(input.keyword)
  const author = readOptionalString(input.author)
  const venue = readOptionalString(input.venue)
  requireAtLeastOne(
    [keyword, author, venue],
    "Provide at least one of keyword, author, or venue."
  )
  const query: QueryEntry[] = [
    ["page", String(readInteger(input.page, { defaultValue: 1, min: 1 }) || 1)],
    [
      "size",
      String(
        readInteger(input.size || input.limit, {
          defaultValue: 10,
          min: 1,
          max: 100,
        }) || 10
      ),
    ],
  ]
  appendQueryEntry(query, "keyword", keyword)
  appendQueryEntry(query, "author", author)
  appendQueryEntry(query, "venue", venue)
  const sortBy = readOptionalString(input.sortBy || input.order)
  if (sortBy && PAPER_SORT_OPTIONS.includes(sortBy)) {
    appendQueryEntry(query, "order", sortBy)
  }
  return { query }
}

function buildPaperKeywordBatchRequest(input: JsonObject) {
  const keywords = readStringArray(input.keywords)
  if (keywords.length === 0) {
    const keyword = readOptionalString(input.keyword)
    if (keyword) keywords.push(keyword)
  }
  if (keywords.length === 0) {
    throw new Error("At least one keyword is required.")
  }
  const query: QueryEntry[] = [
    ["page", String(readInteger(input.page, { defaultValue: 1, min: 1 }) || 1)],
    [
      "size",
      String(
        readInteger(input.size || input.limit, {
          defaultValue: 10,
          min: 1,
          max: 100,
        }) || 10
      ),
    ],
  ]
  appendQueryEntry(query, "keywords", keywords)
  return { query }
}

function buildPapersByVenueYearRequest(input: JsonObject) {
  const year = readInteger(input.year, { min: 0 })
  const venueId = readRequiredString(input, "venueId", "Venue ID")
  if (year === undefined) throw new Error("Year is required.")
  return {
    query: [
      ["year", String(year)],
      ["venue_id", venueId],
    ] as QueryEntry[],
  }
}

function buildPaperInfoBatchRequest(input: JsonObject) {
  const paperIds = dedupe([
    ...readStringArray(input.paperIds),
    ...readStringArray(input.paperId),
  ])
  if (paperIds.length === 0) {
    throw new Error("At least one paperId is required.")
  }
  if (paperIds.length > 100) {
    throw new Error("paperIds cannot exceed 100 items.")
  }
  return { body: { ids: paperIds } }
}

function buildPaperQaSearchRequest(input: JsonObject) {
  const useTopicSearch =
    readOptionalBoolean(input.useTopicSearch ?? input.use_topic) ?? false
  const requiredTopics = readStringMatrix(input.requiredTopics)
  const boostTopics = readStringMatrix(input.boostTopics)
  const softBoostTopics = readStringMatrix(input.softBoostTopics)
  const query = readOptionalString(input.query)
  const titles = readStringArray(input.titles)
  const doi = readOptionalString(input.doi)
  const years = readNumberArray(input.years)
  const authorTerms = readStringArray(input.authorTerms)
  const organizationTerms = readStringArray(input.organizationTerms)
  const authorIds = readStringArray(input.authorIds)
  const organizationIds = readStringArray(input.organizationIds)
  const venueIds = readStringArray(input.venueIds)
  requireAtLeastOne(
    [
      query,
      titles,
      doi,
      requiredTopics,
      boostTopics,
      softBoostTopics,
      authorTerms,
      organizationTerms,
      authorIds,
      organizationIds,
      venueIds,
    ],
    "Provide query or at least one structured search field."
  )

  const body: JsonObject = {
    use_topic: useTopicSearch,
    size:
      readInteger(input.size || input.limit, {
        defaultValue: 20,
        min: 1,
        max: 100,
      }) || 20,
    offset:
      readInteger(input.offset, { defaultValue: 0, min: 0, max: 10_000 }) || 0,
  }
  if (typeof requiredTopics === "string") body.topic_high = requiredTopics
  else if (requiredTopics.length > 0)
    body.topic_high = JSON.stringify(requiredTopics)
  if (typeof boostTopics === "string") body.topic_middle = boostTopics
  else if (boostTopics.length > 0)
    body.topic_middle = JSON.stringify(boostTopics)
  if (typeof softBoostTopics === "string") body.topic_low = softBoostTopics
  else if (softBoostTopics.length > 0)
    body.topic_low = JSON.stringify(softBoostTopics)
  if (titles.length > 0) body.title = titles
  if (doi) body.doi = doi
  if (years.length > 0) body.year = years
  if (query) body.query = query
  if (authorTerms.length > 0) body.author_terms = authorTerms
  if (organizationTerms.length > 0) body.org_terms = organizationTerms
  if (authorIds.length > 0) body.author_id = authorIds
  if (organizationIds.length > 0) body.org_id = organizationIds
  if (venueIds.length > 0) body.venue_ids = venueIds
  const sciOnly = readOptionalBoolean(input.sciOnly ?? input.sci_flag)
  if (sciOnly !== undefined) body.sci_flag = sciOnly
  const preferHighlyCited = readOptionalBoolean(
    input.preferHighlyCited ?? input.n_citation_flag
  )
  if (preferHighlyCited !== undefined) body.n_citation_flag = preferHighlyCited
  const sortByCitations = readOptionalBoolean(
    input.sortByCitations ?? input.force_citation_sort
  )
  if (sortByCitations !== undefined) body.force_citation_sort = sortByCitations
  const sortByYear = readOptionalBoolean(
    input.sortByYear ?? input.force_year_sort
  )
  if (sortByYear !== undefined) body.force_year_sort = sortByYear
  return { body }
}

function buildDeepResearchRequest(input: JsonObject) {
  const message = readRequiredString(input, "message", "Message")
  const corpusType = readInteger(input.corpusType || input.type, {
    defaultValue: 1,
  })
  if (!corpusType || !DEEP_RESEARCH_CORPUS_TYPES.includes(corpusType)) {
    throw new Error(
      "corpusType must be one of 1 (AMiner full corpus), 2 (preprint), or 3 (medical)."
    )
  }
  const body: JsonObject = {
    message,
    type: corpusType,
  }
  const webSearch = readOptionalBoolean(input.webSearch ?? input.web_search)
  if (webSearch !== undefined) body.web_search = webSearch
  return { body }
}

function buildPatentSearchRequest(input: JsonObject) {
  const query = readRequiredString(input, "query", "Patent query")
  return {
    body: {
      query,
      page: readInteger(input.page, { defaultValue: 1, min: 1 }) || 1,
      size:
        readInteger(input.size || input.limit, {
          defaultValue: 10,
          min: 1,
          max: 100,
        }) || 10,
    },
  }
}

function buildOrganizationSearchRequest(input: JsonObject) {
  const queries = dedupe([
    ...readStringArray(input.queries),
    ...readStringArray(input.query),
    ...readStringArray(input.organization),
  ])
  if (queries.length === 0) {
    throw new Error("Provide query or queries.")
  }
  return { body: { orgs: queries } }
}

function buildOrganizationDetailsRequest(input: JsonObject) {
  const ids = dedupe([
    ...readStringArray(input.organizationIds),
    ...readStringArray(input.organizationId),
  ])
  if (ids.length === 0) {
    throw new Error("Provide organizationId or organizationIds.")
  }
  return { body: { ids } }
}

function buildOrganizationNameRequest(input: JsonObject) {
  const organization = readRequiredString(
    input,
    "organization",
    "Organization text"
  )
  return { body: { org: organization } }
}

function buildOrganizationPeopleRequest(input: JsonObject) {
  const organizationId = readRequiredString(
    input,
    "organizationId",
    "Organization ID"
  )
  return {
    query: [
      ["org_id", organizationId],
      [
        "offset",
        String(readInteger(input.offset, { defaultValue: 0, min: 0 }) || 0),
      ],
    ] as QueryEntry[],
  }
}

function buildOrganizationPatentRequest(input: JsonObject) {
  const organizationId = readRequiredString(
    input,
    "organizationId",
    "Organization ID"
  )
  return {
    query: [
      ["id", organizationId],
      [
        "page",
        String(readInteger(input.page, { defaultValue: 1, min: 1 }) || 1),
      ],
      [
        "page_size",
        String(
          readInteger(input.pageSize, {
            defaultValue: 20,
            min: 1,
            max: 100,
          }) || 20
        ),
      ],
    ] as QueryEntry[],
  }
}

function buildVenueSearchRequest(input: JsonObject) {
  const name = readRequiredString(input, "name", "Venue name")
  return { body: { name } }
}

function buildVenuePapersRequest(input: JsonObject) {
  const venueId = readRequiredString(input, "venueId", "Venue ID")
  const body: JsonObject = {
    id: venueId,
    offset: readInteger(input.offset, { defaultValue: 0, min: 0 }) || 0,
    limit:
      readInteger(input.limit || input.size, {
        defaultValue: 20,
        min: 1,
        max: 100,
      }) || 20,
  }
  const year = readInteger(input.year, { min: 0 })
  if (year !== undefined) body.year = year
  return { body }
}

const TOOL_SPECS: AminerToolSpec[] = [
  {
    name: "searchScholars",
    description:
      "Search AMiner scholars by name, organization name, or organization IDs. Returns scholar IDs, names, organizations, interests, and citation counts.",
    method: "POST",
    path: "/person/search",
    params: [
      {
        name: "name",
        type: "string",
        description: "Scholar name to search for.",
      },
      {
        name: "organization",
        type: "string",
        description: "Optional organization name filter.",
      },
      {
        name: "organizationIds",
        type: "string_array",
        description: "Optional AMiner organization IDs to filter by.",
      },
      {
        name: "offset",
        type: "integer",
        description: "Result offset. Defaults to 0.",
        minimum: 0,
      },
      {
        name: "limit",
        type: "integer",
        description: "Number of results to return. Defaults to 10, max 10.",
        minimum: 1,
        maximum: 10,
      },
    ],
    buildRequest: buildScholarSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Scholar search results",
        asObject(result),
        renderScholarItem
      ),
  },
  {
    name: "getScholarDetail",
    description:
      "Get detailed scholar information by AMiner scholar ID, including biography, education, position, honors, and organizations.",
    method: "GET",
    path: "/person/detail",
    params: [
      {
        name: "scholarId",
        type: "string",
        description: "AMiner scholar ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "scholarId", "id", "Scholar ID"),
    formatResult: (result) => formatScholarDetail(asObject(result)),
  },
  {
    name: "getScholarProfile",
    description:
      "Get AMiner scholar profile signals such as interests, domains, and structured background by scholar ID.",
    method: "GET",
    path: "/person/figure",
    params: [
      {
        name: "scholarId",
        type: "string",
        description: "AMiner scholar ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "scholarId", "id", "Scholar ID"),
    formatResult: (result) => formatScholarProfile(asObject(result)),
  },
  {
    name: "listScholarPapers",
    description: "List papers associated with an AMiner scholar ID.",
    method: "GET",
    path: "/person/paper/relation",
    params: [
      {
        name: "scholarId",
        type: "string",
        description: "AMiner scholar ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "scholarId", "id", "Scholar ID"),
    formatResult: (result) =>
      formatListResult("Scholar papers", asObject(result), renderPaperItem),
  },
  {
    name: "listScholarPatents",
    description: "List patents associated with an AMiner scholar ID.",
    method: "GET",
    path: "/person/patent/relation",
    params: [
      {
        name: "scholarId",
        type: "string",
        description: "AMiner scholar ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "scholarId", "id", "Scholar ID"),
    formatResult: (result) =>
      formatListResult("Scholar patents", asObject(result), renderPatentItem),
  },
  {
    name: "listScholarProjects",
    description: "List research projects associated with an AMiner scholar ID.",
    method: "GET",
    path: "/project/person/v3/open",
    params: [
      {
        name: "scholarId",
        type: "string",
        description: "AMiner scholar ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "scholarId", "id", "Scholar ID"),
    formatResult: (result) =>
      formatListResult("Scholar projects", asObject(result), renderProjectItem),
  },
  {
    name: "searchPapersByTitle",
    description:
      "Search papers by title with lightweight paper metadata output.",
    method: "GET",
    path: "/paper/search",
    params: [
      {
        name: "title",
        type: "string",
        description: "Paper title or title fragment.",
        required: true,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "size",
        type: "integer",
        description: "Page size. Defaults to 10.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildPaperSearchByTitleRequest,
    formatResult: (result) =>
      formatListResult(
        "Paper title search results",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "searchPapersAdvanced",
    description:
      "Advanced paper search with title, keyword, abstract, author, organization, venue, and sort options.",
    method: "GET",
    path: "/paper/search/pro",
    params: [
      {
        name: "title",
        type: "string",
        description: "Optional paper title filter.",
      },
      {
        name: "keyword",
        type: "string",
        description: "Optional keyword filter.",
      },
      {
        name: "abstractText",
        type: "string",
        description: "Optional abstract text filter.",
      },
      {
        name: "author",
        type: "string",
        description: "Optional author name filter.",
      },
      {
        name: "organization",
        type: "string",
        description: "Optional organization filter.",
      },
      { name: "venue", type: "string", description: "Optional venue filter." },
      {
        name: "sortBy",
        type: "string",
        description: "Optional sort order.",
        enum: PAPER_SORT_OPTIONS,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "size",
        type: "integer",
        description: "Page size. Defaults to 10.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildPaperSearchAdvancedRequest,
    formatResult: (result) =>
      formatListResult(
        "Advanced paper search results",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "searchPapers",
    description:
      "Search papers by keyword, author, or venue with richer paper metadata than the title-only endpoint.",
    method: "GET",
    path: "/paper/list/by/search/venue",
    params: [
      { name: "keyword", type: "string", description: "Keyword filter." },
      { name: "author", type: "string", description: "Author name filter." },
      { name: "venue", type: "string", description: "Venue name filter." },
      {
        name: "sortBy",
        type: "string",
        description: "Optional sort order.",
        enum: PAPER_SORT_OPTIONS,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "size",
        type: "integer",
        description: "Page size. Defaults to 10.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildPaperSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Paper search results",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "searchPapersByKeywords",
    description:
      "Search papers by multiple keywords. Good for broad recall across related concepts.",
    method: "GET",
    path: "/paper/list/citation/by/keywords",
    params: [
      {
        name: "keywords",
        type: "string_array",
        description: "One or more keywords.",
        required: true,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "size",
        type: "integer",
        description: "Page size. Defaults to 10.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildPaperKeywordBatchRequest,
    formatResult: (result) =>
      formatListResult(
        "Paper keyword search results",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "findPapersByVenueYear",
    description:
      "Find papers for a specific venue and year, using the AMiner endpoint that returns detailed paper records by venue ID and year.",
    method: "GET",
    path: "/paper/platform/allpubs/more/detail/by/ts/org/venue",
    params: [
      {
        name: "year",
        type: "integer",
        description: "Publication year.",
        required: true,
        minimum: 0,
      },
      {
        name: "venueId",
        type: "string",
        description: "AMiner venue ID.",
        required: true,
      },
    ],
    buildRequest: buildPapersByVenueYearRequest,
    formatResult: (result) =>
      formatListResult(
        "Papers by venue and year",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "getPaperInfoBatch",
    description:
      "Get lightweight paper info for up to 100 paper IDs in one request.",
    method: "POST",
    path: "/paper/info",
    params: [
      {
        name: "paperIds",
        type: "string_array",
        description: "List of AMiner paper IDs, up to 100 items.",
        required: true,
      },
    ],
    buildRequest: buildPaperInfoBatchRequest,
    formatResult: (result) =>
      formatListResult("Paper info batch", asObject(result), renderPaperItem),
  },
  {
    name: "getPaperDetail",
    description:
      "Get detailed paper metadata by AMiner paper ID, including abstract, authors, DOI, keywords, and venue data.",
    method: "GET",
    path: "/paper/detail",
    params: [
      {
        name: "paperId",
        type: "string",
        description: "AMiner paper ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "paperId", "id", "Paper ID"),
    formatResult: (result) => formatPaperDetail(asObject(result)),
  },
  {
    name: "listPaperReferences",
    description: "List papers cited by a given paper ID.",
    method: "GET",
    path: "/paper/relation",
    params: [
      {
        name: "paperId",
        type: "string",
        description: "AMiner paper ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "paperId", "id", "Paper ID"),
    formatResult: (result) =>
      formatListResult("Paper references", asObject(result), renderPaperItem),
  },
  {
    name: "askAcademicPapers",
    description:
      "Search academic papers using AMiner's academic QA search endpoint. Supports natural-language queries plus structured filters and nested topic groups.",
    method: "POST",
    path: "/paper/qa/search",
    params: [
      {
        name: "useTopicSearch",
        type: "boolean",
        description:
          "Whether to use the structured topic search mode. Defaults to false.",
      },
      {
        name: "requiredTopics",
        type: "string_matrix",
        description:
          "Nested topic groups that must appear. Inner arrays are OR, outer arrays are AND.",
      },
      {
        name: "boostTopics",
        type: "string_matrix",
        description: "Nested topic groups that strongly boost results.",
      },
      {
        name: "softBoostTopics",
        type: "string_matrix",
        description: "Nested topic groups that softly boost results.",
      },
      {
        name: "query",
        type: "string",
        description: "Natural-language research question.",
      },
      {
        name: "titles",
        type: "string_array",
        description: "Optional title filters.",
      },
      { name: "doi", type: "string", description: "Optional DOI filter." },
      {
        name: "years",
        type: "number_array",
        description: "Optional publication year filters.",
      },
      {
        name: "sciOnly",
        type: "boolean",
        description: "Restrict to SCI papers.",
      },
      {
        name: "preferHighlyCited",
        type: "boolean",
        description: "Boost highly cited papers.",
      },
      {
        name: "sortByCitations",
        type: "boolean",
        description: "Force citation sort.",
      },
      { name: "sortByYear", type: "boolean", description: "Force year sort." },
      {
        name: "authorTerms",
        type: "string_array",
        description: "Author name variants to match.",
      },
      {
        name: "organizationTerms",
        type: "string_array",
        description: "Organization name variants to match.",
      },
      {
        name: "authorIds",
        type: "string_array",
        description: "AMiner author IDs to match.",
      },
      {
        name: "organizationIds",
        type: "string_array",
        description: "AMiner organization IDs to match.",
      },
      {
        name: "venueIds",
        type: "string_array",
        description: "AMiner venue IDs to match.",
      },
      {
        name: "size",
        type: "integer",
        description: "Result count. Defaults to 20, max 100.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "offset",
        type: "integer",
        description: "Offset. Defaults to 0.",
        minimum: 0,
        maximum: 10000,
      },
    ],
    buildRequest: buildPaperQaSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Academic QA paper search results",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "runDeepAcademicResearch",
    description:
      "Run AMiner deep academic research over the selected corpus. Returns streamed thinking and answer chunks collapsed into a final readable transcript.",
    method: "POST",
    path: "/paper/deep_research",
    stream: true,
    params: [
      {
        name: "message",
        type: "string",
        description: "Research prompt or question.",
        required: true,
      },
      {
        name: "corpusType",
        type: "integer",
        description: "1 = AMiner full corpus, 2 = preprint, 3 = medical.",
        required: true,
        enum: DEEP_RESEARCH_CORPUS_TYPES,
      },
      {
        name: "webSearch",
        type: "boolean",
        description: "Whether to allow web resources.",
      },
    ],
    buildRequest: buildDeepResearchRequest,
    formatResult: (result) => formatDeepResearchResult(result),
  },
  {
    name: "searchPatents",
    description: "Search patents by keyword or patent title text.",
    method: "POST",
    path: "/patent/search",
    params: [
      {
        name: "query",
        type: "string",
        description: "Patent search query.",
        required: true,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "size",
        type: "integer",
        description: "Page size. Defaults to 10.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildPatentSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Patent search results",
        asObject(result),
        renderPatentItem
      ),
  },
  {
    name: "getPatentInfo",
    description: "Get lightweight patent metadata by patent ID.",
    method: "GET",
    path: "/patent/info",
    params: [
      {
        name: "patentId",
        type: "string",
        description: "AMiner patent ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "patentId", "id", "Patent ID"),
    formatResult: (result) =>
      formatListResult("Patent info", asObject(result), renderPatentItem),
  },
  {
    name: "getPatentDetail",
    description: "Get detailed patent metadata by patent ID.",
    method: "GET",
    path: "/patent/detail",
    params: [
      {
        name: "patentId",
        type: "string",
        description: "AMiner patent ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdQuery(input, "patentId", "id", "Patent ID"),
    formatResult: (result) => formatPatentDetail(asObject(result)),
  },
  {
    name: "searchOrganizations",
    description:
      "Search AMiner organizations by one or more organization strings.",
    method: "POST",
    path: "/organization/search",
    params: [
      {
        name: "query",
        type: "string",
        description: "Single organization query string.",
      },
      {
        name: "queries",
        type: "string_array",
        description: "Multiple organization query strings.",
      },
    ],
    buildRequest: buildOrganizationSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Organization search results",
        asObject(result),
        renderOrganizationItem
      ),
  },
  {
    name: "getOrganizationDetails",
    description:
      "Get detailed AMiner organization records by one or more organization IDs.",
    method: "POST",
    path: "/organization/detail",
    params: [
      {
        name: "organizationId",
        type: "string",
        description: "Single organization ID.",
      },
      {
        name: "organizationIds",
        type: "string_array",
        description: "Multiple organization IDs.",
      },
    ],
    buildRequest: buildOrganizationDetailsRequest,
    formatResult: (result) => formatOrganizationDetails(asObject(result)),
  },
  {
    name: "normalizeOrganizationName",
    description:
      "Normalize a raw organization string into an AMiner standard organization name.",
    method: "POST",
    path: "/organization/na",
    params: [
      {
        name: "organization",
        type: "string",
        description: "Organization text to normalize.",
        required: true,
      },
    ],
    buildRequest: buildOrganizationNameRequest,
    formatResult: (result) =>
      finalizeOutput(
        "Organization normalization",
        [`Raw response:\n${stringifyClipped(asObject(result).data)}`],
        asObject(result)
      ),
  },
  {
    name: "normalizeOrganizationHierarchy",
    description:
      "Extract first-level and second-level organization IDs from a raw organization string.",
    method: "POST",
    path: "/organization/na/pro",
    params: [
      {
        name: "organization",
        type: "string",
        description: "Organization text to normalize.",
        required: true,
      },
    ],
    buildRequest: buildOrganizationNameRequest,
    formatResult: (result) =>
      finalizeOutput(
        "Organization hierarchy normalization",
        [`Raw response:\n${stringifyClipped(asObject(result).data)}`],
        asObject(result)
      ),
  },
  {
    name: "listOrganizationScholars",
    description: "List scholars associated with an AMiner organization ID.",
    method: "GET",
    path: "/organization/person/relation",
    params: [
      {
        name: "organizationId",
        type: "string",
        description: "AMiner organization ID.",
        required: true,
      },
      {
        name: "offset",
        type: "integer",
        description: "Result offset. Defaults to 0.",
        minimum: 0,
      },
    ],
    buildRequest: buildOrganizationPeopleRequest,
    formatResult: (result) =>
      formatListResult(
        "Organization scholars",
        asObject(result),
        renderScholarItem
      ),
  },
  {
    name: "listOrganizationPapers",
    description: "List papers associated with an AMiner organization ID.",
    method: "GET",
    path: "/organization/paper/relation",
    params: [
      {
        name: "organizationId",
        type: "string",
        description: "AMiner organization ID.",
        required: true,
      },
      {
        name: "offset",
        type: "integer",
        description: "Result offset. Defaults to 0.",
        minimum: 0,
      },
    ],
    buildRequest: buildOrganizationPeopleRequest,
    formatResult: (result) =>
      formatListResult(
        "Organization papers",
        asObject(result),
        renderPaperItem
      ),
  },
  {
    name: "listOrganizationPatents",
    description: "List patents associated with an AMiner organization ID.",
    method: "GET",
    path: "/organization/patent/relation",
    params: [
      {
        name: "organizationId",
        type: "string",
        description: "AMiner organization ID.",
        required: true,
      },
      {
        name: "page",
        type: "integer",
        description: "Page number. Defaults to 1.",
        minimum: 1,
      },
      {
        name: "pageSize",
        type: "integer",
        description: "Page size. Defaults to 20.",
        minimum: 1,
        maximum: 100,
      },
    ],
    buildRequest: buildOrganizationPatentRequest,
    formatResult: (result) =>
      formatListResult(
        "Organization patents",
        asObject(result),
        renderPatentItem
      ),
  },
  {
    name: "searchVenues",
    description: "Search venues by venue name.",
    method: "POST",
    path: "/venue/search",
    params: [
      {
        name: "name",
        type: "string",
        description: "Venue name.",
        required: true,
      },
    ],
    buildRequest: buildVenueSearchRequest,
    formatResult: (result) =>
      formatListResult(
        "Venue search results",
        asObject(result),
        renderVenueItem
      ),
  },
  {
    name: "getVenueDetail",
    description: "Get venue detail by AMiner venue ID.",
    method: "POST",
    path: "/venue/detail",
    params: [
      {
        name: "venueId",
        type: "string",
        description: "AMiner venue ID.",
        required: true,
      },
    ],
    buildRequest: (input) =>
      buildSingleIdBody(input, "venueId", "id", "Venue ID"),
    formatResult: (result) => formatVenueDetail(asObject(result)),
  },
  {
    name: "listVenuePapers",
    description:
      "List papers associated with a venue, optionally filtered by year.",
    method: "POST",
    path: "/venue/paper/relation",
    params: [
      {
        name: "venueId",
        type: "string",
        description: "AMiner venue ID.",
        required: true,
      },
      {
        name: "offset",
        type: "integer",
        description: "Offset. Defaults to 0.",
        minimum: 0,
      },
      {
        name: "limit",
        type: "integer",
        description: "Number of results. Defaults to 20.",
        minimum: 1,
        maximum: 100,
      },
      {
        name: "year",
        type: "integer",
        description: "Optional publication year filter.",
        minimum: 0,
      },
    ],
    buildRequest: buildVenuePapersRequest,
    formatResult: (result) =>
      formatListResult("Venue papers", asObject(result), renderPaperItem),
  },
]

const TOOL_SPEC_MAP = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))

export const aminerToolDefinitions = TOOL_SPECS.map(buildToolDefinition)

export async function executeAminerTool(
  toolName: string,
  input: JsonObject,
  config: JsonObject
) {
  const spec = TOOL_SPEC_MAP.get(toolName)
  if (!spec) {
    throw new Error(`Unknown AMiner tool: ${toolName}`)
  }
  const response = await fetchAminer(spec, input, config)
  return spec.formatResult(response)
}
