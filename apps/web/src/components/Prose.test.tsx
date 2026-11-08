import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Prose } from "./Prose";

const html = (text: string) => renderToStaticMarkup(<Prose text={text} />);

describe("markdown subset", () => {
  it("renders bold, without the raw markers", () => {
    const h = html("This is **important** and **this too**.");
    expect(h).toContain("<strong>important</strong>");
    expect(h).toContain("<strong>this too</strong>");
    expect(h).not.toContain("**");
  });
  it("renders bullet lists with -, * and a bullet dot", () => {
    const h = html("Done:\n- Intervals on 05/11\n* Easy run on 07/11\n• Long run on 08/11\n\nNext.");
    expect(h.match(/<li>/g)).toHaveLength(3);
    expect(h).toContain("<ul");
    expect(h).toContain("<li>Intervals on 05/11</li>");
    expect(h).toContain("<p>Next.</p>");
  });
  it("keeps line breaks inside a paragraph and splits paragraphs on blank lines", () => {
    const h = html("This week: a.\nReadings: b.\n\nNext week: c.");
    expect(h).toContain("This week: a.<br/>Readings: b.");
    expect(h.match(/<p>/g)).toHaveLength(2);
  });
  it("bold inside a bullet works", () => {
    expect(html("- **Missed:** Easy 40")).toContain("<li><strong>Missed:</strong> Easy 40</li>");
  });
  it("shows a script tag as text, never as HTML", () => {
    const h = html('Hello <script>alert("x")</script> <img src=x onerror=alert(1)> world');
    expect(h).not.toContain("<script");
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("&lt;img");
  });
  it("never makes a link live: markdown links, autolinks and raw anchors stay text", () => {
    const h = html("[click](http://evil.example) <https://evil.example> <a href=\"http://evil.example\">x</a> https://evil.example");
    expect(h).not.toMatch(/<a[\s>]/); // no live anchor element (the escaped text "&lt;a href" is only text)
    expect(h).toContain("&lt;a href");
    expect(h).toContain("[click](http://evil.example)");
  });
  it("does not render other markdown: headings, code and italics stay plain", () => {
    const h = html("# Title\n`code` and *italic*");
    expect(h).not.toMatch(/<h\d|<code|<em/);
    expect(h).toContain("# Title");
  });
  it("an unclosed marker stays as typed", () => {
    expect(html("**unclosed and more")).toContain("**unclosed and more");
  });
});
