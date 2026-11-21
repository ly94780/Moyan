import { describe, expect, it } from 'vitest';
import { imageSource, renderMarkdown } from '../src/renderer/features/preview/markdown';

describe('Markdown 阅读渲染', () => {
  // This checks completeness of an extreme paragraph; timing is recorded separately in desktop tests.
  it('两万行文档保留末尾内容', () => {
    const content =
      '# 性能样例\n\n' +
      Array.from(
        { length: 20000 },
        (_, i) => `第${i}行，记录想法与文字。Markdown editor sample.\n`,
      ).join('');
    const result = renderMarkdown(content);
    expect(result.html.includes('第19999行')).toBe(true);
  }, 20000);
  it('支持中文重复标题、GFM 表格与任务列表', () => {
    const result = renderMarkdown(
      '# 中文标题\n\n## 中文标题\n\n- [x] 完成\n\n| A | B |\n| --- | --- |\n| 一 | 二 |',
    );
    expect(result.headings.map((h) => h.id)).toEqual(['h-中文标题', 'h-中文标题-1']);
    expect(result.html).toContain('<table>');
    expect(result.html).toContain('type="checkbox"');
    expect(result.html).toContain('id="h-中文标题"');
  });
  it('HTML 仅作为文本，危险协议无法执行', () => {
    const result = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert%281%29)\n\n```html\n<script>code</script>\n```',
    );
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('<img');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).toMatch(/(?:&lt;|&#x3C;)script(?:&gt;|>)/);
  });
  it('网络图片默认关闭，本地图片经过受控协议加载', () => {
    expect(imageSource('https://example.com/a.png', 'id', false)).toBeNull();
    expect(imageSource('https://example.com/a.png', 'id', true)).toBe('https://example.com/a.png');
    expect(imageSource('file:///C:/secret.png', 'id', true)).toBeNull();
    expect(imageSource('data:image/svg+xml,x', 'id', true)).toBeNull();
    expect(renderMarkdown('![图](images/a.png)', 'abc').html).toContain(
      'moyan-image://abc/images%2Fa.png',
    );
  });
  it('字数按汉字与英文数字词统计，排除 Markdown 标记', () => {
    expect(renderMarkdown('# 中文 **Hello** world 123').words).toBe(5);
    expect(renderMarkdown('Hello中文\n\nworld\n\n- one\n- two').words).toBe(6);
  });
});
