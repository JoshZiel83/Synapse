import { textBlocks, ToolDefinition } from "@synapse/shared"
import type { SubFeature } from "./types.js"
import type { BuiltinPluginExecuteResult } from "../../index.js"
import {
  fileRefProperty,
  resolveImageFileRefToDataUrl,
  resolveVideoFileRefToPublicUrl,
} from "../../../file-ref.js"
import {
  normalizeZhipuTransportError,
  throwZhipuApiError,
} from "./zhipu-errors.js"

const ZHIPU_CHAT_ENDPOINT =
  "https://open.bigmodel.cn/api/paas/v4/chat/completions"
const DEFAULT_MODEL = "glm-4v-flash"

interface VisionMessage {
  role: "user" | "assistant"
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "ui_to_artifact",
    description:
      "Convert a UI screenshot into code guidance, a generation prompt, a design specification, or a natural-language description.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("UI screenshot image to analyze."),
        artifactType: {
          type: "string",
          description: "Target artifact to generate from the screenshot.",
          enum: [
            "frontend_code",
            "design_prompt",
            "design_spec",
            "natural_language",
          ],
        },
        framework: {
          type: "string",
          description:
            "Optional frontend framework or target stack, such as React, Vue, HTML/CSS, Tailwind, or SwiftUI.",
        },
        instructions: {
          type: "string",
          description:
            "Optional extra instructions about style, fidelity, components, or output constraints.",
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "image_analysis",
    description:
      "General-purpose image understanding for visual content not covered by the more specialized screenshot or diagram tools.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Image file to analyze."),
        focus: {
          type: "string",
          description:
            "Optional focus area or aspect to emphasize in the analysis",
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "extract_text_from_screenshot",
    description:
      "Extract visible text from screenshots, code panes, terminal output, documents, and other on-screen text.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Screenshot image to extract text from."),
        language: {
          type: "string",
          description: 'Expected language of the text (e.g., "en", "zh")',
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "diagnose_error_screenshot",
    description:
      "Analyze an error screenshot, popup, stack trace, or failing UI state and provide diagnosis plus suggested fixes.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty(
          "Screenshot image containing the error state."
        ),
        context: {
          type: "string",
          description:
            "Additional context about what was happening when the error occurred",
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "understand_technical_diagram",
    description:
      "Interpret architecture diagrams, flowcharts, UML, ER diagrams, and other technical drawings.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Technical diagram image to analyze."),
        diagram_type: {
          type: "string",
          description:
            "Type of diagram (architecture, flowchart, UML, ER, etc.)",
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "analyze_data_visualization",
    description:
      "Analyze dashboards, charts, and graphs to extract trends, anomalies, and key business insights.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty(
          "Chart or data visualization image to analyze."
        ),
        questions: {
          type: "string",
          description: "Specific questions to answer about the data",
        },
      },
      required: ["fileRef"],
    },
  },
  {
    name: "ui_diff_check",
    description:
      "Compare two UI screenshots to find visual differences, regressions, and design-to-implementation mismatches.",
    parameters: {
      type: "object",
      properties: {
        beforeFileRef: fileRefProperty("Before/reference screenshot."),
        afterFileRef: fileRefProperty("After/current screenshot."),
        focus_areas: {
          type: "string",
          description: "Specific areas to focus the comparison on",
        },
      },
      required: ["beforeFileRef", "afterFileRef"],
    },
  },
  {
    name: "image_qa",
    description: "Answer specific questions about the content of an image.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Image file to ask about."),
        question: {
          type: "string",
          description: "The question to answer about the image",
        },
      },
      required: ["fileRef", "question"],
    },
  },
  {
    name: "video_analysis",
    description:
      "Analyze video content and summarize key scenes, events, and details. Intended for common MP4/MOV/M4V-style video understanding workflows.",
    parameters: {
      type: "object",
      properties: {
        fileRef: fileRefProperty("Video file to analyze."),
        question: {
          type: "string",
          description: "Optional specific question about the video content",
        },
      },
      required: ["fileRef"],
    },
  },
]

const TOOL_PROMPTS: Record<
  string,
  (input: Record<string, unknown>) => {
    prompt: string
    fileRefs: unknown[]
    kind: "image" | "video"
  }
> = {
  ui_to_artifact: (input) => {
    const artifactType =
      typeof input.artifactType === "string"
        ? input.artifactType
        : "natural_language"
    const targetMap: Record<string, string> = {
      frontend_code: "frontend implementation guidance or code scaffolding",
      design_prompt: "a prompt for image/UI generation systems",
      design_spec: "a structured UI design specification",
      natural_language: "a natural-language UI description",
    }
    return {
      prompt:
        `Analyze this UI screenshot and convert it into ${targetMap[artifactType] || targetMap.natural_language}.` +
        `${input.framework ? ` Target framework or stack: ${input.framework}.` : ""}` +
        `${input.instructions ? ` Additional instructions: ${input.instructions}` : ""}` +
        " Focus on layout, hierarchy, spacing, components, states, copy, colors, and interactions that are visible in the screenshot.",
      fileRefs: [input.fileRef],
      kind: "image",
    }
  },
  image_analysis: (input) => ({
    prompt: `Please analyze this image in detail.${input.focus ? ` Focus on: ${input.focus}` : ""} Describe objects, scenes, text, and notable features.`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  extract_text_from_screenshot: (input) => ({
    prompt: `Extract all visible text from this screenshot.${input.language ? ` Text language: ${input.language}` : ""} Preserve the layout and ordering.`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  diagnose_error_screenshot: (input) => ({
    prompt: `Analyze this error screenshot.${input.context ? ` Context: ${input.context}` : ""} Identify the error, diagnose likely causes, and suggest fixes.`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  understand_technical_diagram: (input) => ({
    prompt: `Analyze this technical diagram${input.diagram_type ? ` (type: ${input.diagram_type})` : ""}. Explain its components, relationships, and data flow.`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  analyze_data_visualization: (input) => ({
    prompt: `Analyze this data visualization.${input.questions ? ` Answer: ${input.questions}` : " Extract key data points, trends, and insights."}`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  ui_diff_check: (input) => ({
    prompt: `Compare these two UI screenshots and identify visual differences, layout changes, or regressions.${input.focus_areas ? ` Focus on: ${input.focus_areas}` : ""} The first image is the before/reference version, the second is the current version.`,
    fileRefs: [input.beforeFileRef, input.afterFileRef],
    kind: "image",
  }),
  image_qa: (input) => ({
    prompt: `About this image, please answer: ${input.question}`,
    fileRefs: [input.fileRef],
    kind: "image",
  }),
  video_analysis: (input) => ({
    prompt: `Analyze this video content.${input.question ? ` Answer: ${input.question}` : " Provide a detailed summary."}`,
    fileRefs: [input.fileRef],
    kind: "video",
  }),
}

async function callGLM4V(
  apiKey: string,
  prompt: string,
  imageUrls: string[],
  model?: string
): Promise<string> {
  const content: VisionMessage["content"] = []

  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url } })
  }
  content.push({ type: "text", text: prompt })

  const body = {
    model: model || DEFAULT_MODEL,
    messages: [{ role: "user", content }],
    max_tokens: 2048,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)

  try {
    const response = await fetch(ZHIPU_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      await throwZhipuApiError("视觉理解 API", response)
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    return (
      result.choices?.[0]?.message?.content || "No response from vision model"
    )
  } catch (error) {
    throw normalizeZhipuTransportError("视觉理解 API", error)
  } finally {
    clearTimeout(timeout)
  }
}

export const visionFeature: SubFeature = {
  featureKey: "feature_vision",

  getTools(): ToolDefinition[] {
    return TOOL_DEFINITIONS
  },

  async execute(
    toolName: string,
    input: Record<string, unknown>,
    config: Record<string, unknown>
  ): Promise<BuiltinPluginExecuteResult> {
    const apiKey = config.apiKey as string
    if (!apiKey) {
      throw new Error("ZhipuAI API key not configured.")
    }

    const promptBuilder = TOOL_PROMPTS[toolName]
    if (!promptBuilder) {
      throw new Error(`Unknown vision tool: ${toolName}`)
    }

    const { prompt, fileRefs, kind } = promptBuilder(input)
    const images = await Promise.all(
      fileRefs.map((fileRef, index) =>
        kind === "video"
          ? resolveVideoFileRefToPublicUrl(fileRef, `fileRef[${index}]`)
          : resolveImageFileRefToDataUrl(fileRef, `fileRef[${index}]`)
      )
    )
    const model = (config.visionModel as string) || DEFAULT_MODEL

    return textBlocks(await callGLM4V(apiKey, prompt, images, model))
  },
}
