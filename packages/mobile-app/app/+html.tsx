import { ScrollViewStyleReset } from 'expo-router/html';

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        <meta name="theme-color" content="#f4efe7" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
html {
  background: #f4efe7;
}

body {
  background:
    radial-gradient(circle at top right, rgba(216, 239, 233, 0.7), transparent 28%),
    radial-gradient(circle at 15% 20%, rgba(232, 111, 81, 0.14), transparent 22%),
    #f4efe7;
}
`;
