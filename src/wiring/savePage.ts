import { Page } from "playwright";
import { JSDOM } from "jsdom";
import { createWriteStream, existsSync } from "fs";
import { pathToFileURL } from "url";
import fetchPageList from "./fetchPageList";
import fetchBasicPage from "./fetchBasicPage";
import {
  WiringFetchParams,
  WiringTableOfContentsEntry,
} from "./fetchTableOfContents";
import fetchSvg from "./fetchSvg";
import { join, resolve } from "path";
import { writeFile } from "fs/promises";
import { pipeline } from "stream/promises";
import { sanitizeName } from "../utils";

export interface WiringFetchPageParams extends WiringFetchParams {
  vehicleId: string;
  country: string;
}

export default async function savePage(
  params: WiringFetchPageParams,
  doc:
    | (WiringTableOfContentsEntry & { Type: "Page" })
    | (WiringTableOfContentsEntry & { Type: "BasicPage" }),
  browserPage: Page,
  folderPath: string,
  ignoreSaveErrors: boolean = false
): Promise<void> {
  const pageList = await fetchPageList({
    ...params,
    cell: doc.Number,
    title: doc.Title,
    page: "1",
  });

  await writeFile(
    join(folderPath, "pageList.json"),
    JSON.stringify(pageList, null, 2)
  );

  for (const subPage of pageList as any[]) {
    try {
      if (
        subPage &&
        typeof subPage === "object" &&
        "Value" in subPage &&
        "Text" in subPage
      ) {
        // Legacy BasicPage format item.
        const basicPage = subPage as { Value: string; Text: string };
        const pdfPath = join(folderPath, `${basicPage.Text}.pdf`);

        if (existsSync(pdfPath)) {
          console.log(
            `Skipping page ${basicPage.Text} of ${doc.Title} (already exists)...`
          );
          continue;
        }

        console.log(`Saving page ${basicPage.Text} of ${doc.Title}...`);
        const stream = await fetchBasicPage(`${basicPage.Text}.pdf`, params.book);
        await pipeline(stream as any, createWriteStream(pdfPath));
        continue;
      }

      let pageNumber: string | null = null;

      if (typeof subPage === "string") {
        pageNumber = subPage;
      } else if (subPage && typeof subPage === "object") {
        // Current Ford format: {cell, page, Code, Startdate, Enddate}
        if ("page" in subPage && subPage.page) {
          pageNumber = String(subPage.page);
        }
      }

      if (!pageNumber) {
        console.warn(
          `  Skipping unrecognized subpage format in ${doc.Title}: ${JSON.stringify(
            subPage
          )}`
        );
        continue;
      }

      console.log(`Saving page ${pageNumber} of ${doc.Title}...`);

      const svg = await fetchSvg(
        doc.Number,
        pageNumber,
        params.environment,
        params.vehicleId,
        params.book,
        params.languageCode
      );

      const dom = new JSDOM(svg);
      const svgElement = dom.window.document.querySelector("svg");
      if (!svgElement) {
        console.error(
          `  No SVG element found in Wiring SVG for ${doc.Title} ${pageNumber}`
        );
        continue;
      }

      svgElement.setAttribute("xmlns", "http://www.w3.org/2000/svg");

      let title = pageNumber;

      const headerElement = dom.window.document.getElementById("Header");
      if (headerElement) {
        const child = headerElement.firstElementChild;
        if (child && child.textContent) {
          title += ` ${sanitizeName(child.textContent)}`;
        }
      }

      const svgString = dom.serialize();
      const svgPath = join(folderPath, `${title}.svg`);
      await writeFile(svgPath, svgString);

      const pdfPath = join(folderPath, `${title}.pdf`);
      if (existsSync(pdfPath)) {
        console.log(
          `Skipping page ${pageNumber} of ${doc.Title} (already exists)...`
        );
        continue;
      }

      // Use pathToFileURL to properly handle special characters like # in filenames.
      const fileUrl = pathToFileURL(resolve(svgPath)).href;
      await browserPage.goto(fileUrl);
      await browserPage.pdf({
        path: pdfPath,
        landscape: true,
      });
    } catch (e: any) {
      if (ignoreSaveErrors) {
        console.error(
          `  Failed to save subpage of ${doc.Title}: ${e.message}`
        );
        continue;
      }
      throw e;
    }
  }
}
