import ChatMarkdownDom from "@/components/chat-markdown-dom";

export function ChatMarkdown({
  markdown,
  mine,
}: {
  markdown: string;
  mine: boolean;
}) {
  if (!markdown.trim()) {
    return null;
  }

  return (
    <ChatMarkdownDom
      markdown={markdown}
      mine={mine}
      dom={{
        matchContents: true,
        scrollEnabled: false,
        style: {
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          overflow: "hidden",
          backgroundColor: "transparent",
        },
      }}
    />
  );
}
