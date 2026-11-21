import { useEffect, useRef } from 'react';
import styles from '../../styles/App.module.css';
interface Props {
  html: string;
  size: number;
  onError(message: string): void;
}
export function Preview({ html, size, onError }: Props) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const article = root.current;
    if (!article) return;
    article.querySelectorAll('pre').forEach((pre) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '复制';
      button.title = '复制代码';
      button.className = 'copy-code';
      pre.appendChild(button);
    });
    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const copy = target.closest<HTMLButtonElement>('.copy-code');
      if (copy) {
        void navigator.clipboard
          .writeText(copy.parentElement?.querySelector('code')?.textContent ?? '')
          .then(() => {
            copy.textContent = '已复制';
          })
          .catch(() => onError('复制失败，请选中代码后按 Ctrl+C。'));
      }
      const link = target.closest<HTMLAnchorElement>('a');
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        try {
          const fragment = decodeURIComponent(href.slice(1));
          const headingId = `h-${
            fragment
              .toLowerCase()
              .replace(/[^\p{L}\p{N}_-]+/gu, '-')
              .slice(0, 100) || 'section'
          }`;
          (document.getElementById(fragment) ?? document.getElementById(headingId))?.scrollIntoView(
            { behavior: 'smooth' },
          );
        } catch {
          /* invalid anchor */
        }
      } else if (/^https?:\/\//i.test(href)) {
        void window.desktop.external(href).then((result) => {
          if (!result.ok) onError(result.error);
        });
      } else onError('首版支持网页链接与文内标题跳转。');
    };
    const imageError = (event: Event) => {
      if (event.target instanceof HTMLImageElement) {
        const label = document.createElement('span');
        label.className = 'image-error';
        label.textContent = `图片无法加载：${event.target.alt || '请检查相对路径与图片格式'}`;
        event.target.replaceWith(label);
      }
    };
    article.addEventListener('click', click);
    article.addEventListener('error', imageError, true);
    return () => {
      article.removeEventListener('click', click);
      article.removeEventListener('error', imageError, true);
    };
  }, [html, onError]);
  return (
    <article
      ref={root}
      className={styles.markdown}
      style={{ fontSize: size }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
