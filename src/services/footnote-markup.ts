export const FOOTNOTE_TOGGLE_ONCLICK =
  "var s=this.parentElement.nextElementSibling;var expanded=this.getAttribute('aria-expanded')==='true';s.hidden=expanded;this.setAttribute('aria-expanded',expanded?'false':'true');this.title=expanded?'Show footnote':'Hide footnote';";

export function renderFootnoteRef(
  num: string,
  bodyHtml: string,
  buttonStyle = "color:#666;font-size:11px;vertical-align:super;cursor:pointer;border:none;background:none;padding:0;font-family:inherit;"
): string {
  return `<sup><button type="button" data-footnote-toggle="true" aria-expanded="false" onclick="${FOOTNOTE_TOGGLE_ONCLICK}" style="${buttonStyle}">[${num}]</button></sup><span data-footnote-body="true" hidden style="font-size:13px;color:#555;margin-left:4px;"> ${bodyHtml}</span>`;
}

export function upgradeFootnoteMarkup(html: string): string {
  return html.replace(
    /<sup[^>]*>\s*(<button[^>]*data-footnote-toggle=["']true["'][^>]*>\[\d+\]<\/button>)\s*(<span[^>]*data-footnote-body=["']true["'][^>]*>[\s\S]*?<\/span>)\s*<\/sup>/gi,
    (_match, button: string, body: string) => {
      const fixedButton = button.replace(
        /var s=this\.nextElementSibling/,
        "var s=this.parentElement.nextElementSibling"
      );
      return `<sup>${fixedButton}</sup>${body}`;
    }
  );
}
