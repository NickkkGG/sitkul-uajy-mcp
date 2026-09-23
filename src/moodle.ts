import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

export type Course = { id: string; name: string; url: string };
export type Activity = {
  courseId: string;
  courseName?: string;
  id: string;
  name: string;
  url: string;
  context: string;
  dueAt?: string;
};
export type Material = {
  name: string;
  url: string;
  section?: string;
  kind: "file" | "resource" | "link";
  /** The destination for Moodle URL activities, when it can be resolved safely. */
  targetUrl?: string;
};
export type AssignmentAttachment = { name: string; url: string };

const DEFAULT_BASE_URL = "https://kuliah.uajy.ac.id";
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueByUrl<T extends { url: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.url, item])).values()];
}

function parseCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (withGetSetCookie.getSetCookie) return withGetSetCookie.getSetCookie();
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

export class MoodleClient {
  private readonly origin: string;
  private readonly baseUrl: string;
  private readonly cookies = new Map<string, string>();
  private loggedIn = false;
  private loginPromise: Promise<void> | undefined;

  constructor(
    private readonly username: string | undefined,
    private readonly password: string | undefined,
    baseUrl = process.env.SITKUL_BASE_URL ?? DEFAULT_BASE_URL,
  ) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:") throw new Error("SITKUL_BASE_URL must use HTTPS.");
    this.origin = parsed.origin;
    this.baseUrl = `${this.origin}${parsed.pathname.replace(/\/$/, "")}`;
  }

  private absolute(url: string): URL {
    const absolute = new URL(url, `${this.baseUrl}/`);
    if (absolute.origin !== this.origin) {
      throw new Error("Blocked a URL outside the configured Moodle site.");
    }
    return absolute;
  }

  private storeCookies(headers: Headers): void {
    for (const header of parseCookies(headers)) {
      const pair = header.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  private cookieHeader(): string | undefined {
    const value = [...this.cookies.entries()].map(([name, cookie]) => `${name}=${cookie}`).join("; ");
    return value || undefined;
  }

  private async request(url: string | URL, init: RequestInit = {}, redirects = 0): Promise<Response> {
    if (redirects > 5) throw new Error("Too many redirects from Moodle.");
    const absolute = this.absolute(String(url));
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);

    const response = await fetch(absolute, { ...init, headers, redirect: "manual" });
    this.storeCookies(response.headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    const nextInit = response.status === 307 || response.status === 308
      ? init
      : { method: "GET", headers: init.headers };
    return this.request(this.absolute(location), nextInit, redirects + 1);
  }

  private assertAuthenticated(html: string, response: Response): void {
    if (response.url.includes("/login/") || /name=["']password["']/i.test(html)) {
      this.loggedIn = false;
      throw new Error("Moodle session expired or credentials were rejected. Restart the MCP server after correcting .env.");
    }
  }

  async ensureLogin(): Promise<void> {
    if (this.loggedIn) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => { this.loginPromise = undefined; });
    }
    return this.loginPromise;
  }

  private async login(): Promise<void> {
    if (!this.username || !this.password) {
      throw new Error("Missing SITKUL_USERNAME or SITKUL_PASSWORD. Copy .env.example to .env and set both values.");
    }
    const loginPage = await this.request("/login/index.php");
    const loginHtml = await loginPage.text();
    const $ = cheerio.load(loginHtml);
    const token = $("input[name=logintoken]").attr("value");
    if (!token) throw new Error("The Moodle login form did not contain a login token.");

    const form = new URLSearchParams({ anchor: "", logintoken: token, username: this.username, password: this.password });
    const response = await this.request("/login/index.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const html = await response.text();
    this.assertAuthenticated(html, response);
    this.loggedIn = true;
  }

  private async page(path: string): Promise<string> {
    await this.ensureLogin();
    const response = await this.request(path);
    const html = await response.text();
    this.assertAuthenticated(html, response);
    if (!response.ok) throw new Error(`Moodle returned HTTP ${response.status}.`);
    return html;
  }

  async listCourses(): Promise<Course[]> {
    const courses: Course[] = [];
    // UAJY's /my/courses.php can be empty while its dashboard still contains the
    // enrolled-course cards, so inspect both standard Moodle views.
    for (const path of ["/my/courses.php", "/my/"]) {
      const html = await this.page(path);
      const $ = cheerio.load(html);
      $("a[href*='/course/view.php?id=']").each((_, element) => {
        const href = $(element).attr("href");
        const name = compact($(element).text());
        if (!href || !name) return;
        const url = this.absolute(href);
        const id = url.searchParams.get("id");
        if (id) courses.push({ id, name, url: url.href });
      });
    }
    return uniqueByUrl(courses);
  }

  private static activityFromAnchor($: cheerio.CheerioAPI, element: Element, course: Course): Activity | undefined {
    const href = $(element).attr("href");
    const name = compact($(element).text());
    if (!href || !name) return undefined;
    const url = new URL(href, DEFAULT_BASE_URL);
    const id = url.searchParams.get("id");
    if (!id) return undefined;
    const container = $(element).closest("li, .activity, .courseindex-item, tr, div").first();
    const context = compact(container.text());
    const time = container.find("time[datetime]").first().attr("datetime");
    const parsed = time && !Number.isNaN(Date.parse(time)) ? new Date(time).toISOString() : undefined;
    return { courseId: course.id, courseName: course.name, id, name, url: url.href, context, dueAt: parsed };
  }

  async listAssignments(courseId?: string): Promise<Activity[]> {
    const courses = courseId ? (await this.listCourses()).filter((course) => course.id === courseId) : await this.listCourses();
    if (courseId && courses.length === 0) throw new Error(`Course ${courseId} was not found in your enrolled courses.`);
    const activities: Activity[] = [];
    for (const course of courses) {
      const html = await this.page(`/course/view.php?id=${encodeURIComponent(course.id)}`);
      const $ = cheerio.load(html);
      $("a[href*='/mod/assign/view.php?id=']").each((_, element) => {
        const activity = MoodleClient.activityFromAnchor($, element, course);
        if (activity) activities.push(activity);
      });
    }
    return uniqueByUrl(activities);
  }

  async listDeadlines(courseId?: string): Promise<Activity[]> {
    const assignments = await this.listAssignments(courseId);
    const deadlines: Activity[] = [];
    for (const assignment of assignments) {
      const html = await this.page(assignment.url);
      const $ = cheerio.load(html);
      let dueAt: string | undefined;
      $("time[datetime]").each((_, element) => {
        const nearby = compact($(element).parent().text()).toLowerCase();
        const datetime = $(element).attr("datetime");
        if (!dueAt && datetime && /due|batas|deadline/.test(nearby) && !Number.isNaN(Date.parse(datetime))) {
          dueAt = new Date(datetime).toISOString();
        }
      });
      const context = compact($("#region-main, main, body").first().text()).slice(0, 800);
      // UAJY's Moodle theme currently renders an assignment due date as text
      // (for example "Due: Tuesday, 22 September 2026, 9:00 PM") instead of <time>.
      const textDue = /\bDue:\s*([A-Za-z]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(context)?.[1];
      if (!dueAt && textDue && !Number.isNaN(Date.parse(textDue))) {
        dueAt = new Date(textDue).toISOString();
      }
      deadlines.push({ ...assignment, dueAt, context });
    }
    return deadlines.sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
  }

  async getAssignmentDetails(assignmentUrl: string): Promise<{
    name: string;
    instructions: string;
    dueAt?: string;
    submissionStatus?: string;
    gradingStatus?: string;
    timeRemaining?: string;
    lastModified?: string;
    canSubmit: boolean;
  }> {
    const assignment = this.absolute(assignmentUrl);
    if (!assignment.pathname.includes("/mod/assign/view.php")) {
      throw new Error("Use an assignment URL returned by list_assignments.");
    }
    const html = await this.page(assignment.href);
    const $ = cheerio.load(html);
    const main = $("#region-main, main").first();
    const pageText = compact(main.text());
    const values = new Map<string, string>();
    main.find("tr").each((_, row) => {
      const label = compact($(row).find("th").first().text());
      const value = compact($(row).find("td").first().text());
      if (label && value) values.set(label.toLowerCase(), value);
    });
    const dueText = /\bDue:\s*([A-Za-z]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4},\s*\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(pageText)?.[1];
    const dueAt = dueText && !Number.isNaN(Date.parse(dueText)) ? new Date(dueText).toISOString() : undefined;
    return {
      name: compact($("h1, .activity-header h2, .activity-header h3").first().text()) || "Assignment",
      instructions: compact($("#intro").text()),
      dueAt,
      submissionStatus: values.get("submission status"),
      gradingStatus: values.get("grading status"),
      timeRemaining: values.get("time remaining"),
      lastModified: values.get("last modified"),
      canSubmit: /\b(?:Add|Edit) submission\b/i.test(pageText),
    };
  }

  async listAssignmentAttachments(assignmentUrl: string): Promise<AssignmentAttachment[]> {
    const assignment = this.absolute(assignmentUrl);
    if (!assignment.pathname.includes("/mod/assign/view.php")) {
      throw new Error("Use an assignment URL returned by list_assignments.");
    }
    const html = await this.page(assignment.href);
    const $ = cheerio.load(html);
    const attachments: AssignmentAttachment[] = [];
    $("#intro a[href*='/pluginfile.php/'], .activity-description a[href*='/pluginfile.php/']").each((_, element) => {
      const href = $(element).attr("href");
      const name = compact($(element).text()) || compact($(element).attr("title") ?? "");
      if (!href || !name) return;
      attachments.push({ name, url: this.absolute(href).href });
    });
    return uniqueByUrl(attachments);
  }

  async listMaterials(courseId: string): Promise<Material[]> {
    const course = (await this.listCourses()).find((item) => item.id === courseId);
    if (!course) throw new Error(`Course ${courseId} was not found in your enrolled courses.`);
    const html = await this.page(`/course/view.php?id=${encodeURIComponent(courseId)}`);
    const $ = cheerio.load(html);
    const candidates: Material[] = [];
    $("a[href*='/pluginfile.php/'], a[href*='/mod/resource/view.php?id='], a[href*='/mod/url/view.php?id=']").each((_, element) => {
      const href = $(element).attr("href");
      const name = compact($(element).text()) || compact($(element).attr("title") ?? "");
      if (!href || !name) return;
      const section = compact($(element).closest("li.section, .course-section, section").find(".sectionname, h3, h4").first().text()) || undefined;
      const url = this.absolute(href).href;
      const kind = url.includes("/pluginfile.php/")
        ? "file"
        : url.includes("/mod/resource/view.php")
          ? "resource"
          : "link";
      candidates.push({ name, url, section, kind });
    });
    const materials = uniqueByUrl(candidates);
    for (const material of materials) {
      if (material.kind !== "link") continue;
      const linkPage = await this.page(material.url);
      const linkPage$ = cheerio.load(linkPage);
      const destination = linkPage$("a[href]").toArray()
        .map((element) => linkPage$(element).attr("href"))
        .find((href): href is string => {
          if (!href || href.startsWith("#")) return false;
          try { return new URL(href, this.baseUrl).origin !== this.origin; } catch { return false; }
        });
      if (destination) material.targetUrl = new URL(destination, this.baseUrl).href;
    }
    return materials;
  }

  async downloadMaterial(materialUrl: string, outputDirectory: string): Promise<{ path: string; bytes: number }> {
    await this.ensureLogin();
    const material = this.absolute(materialUrl);
    const isFile = material.pathname.includes("/pluginfile.php/");
    const isResource = material.pathname.includes("/mod/resource/view.php");
    if (!isFile && !isResource) throw new Error("Only Moodle material URLs returned by list_materials may be downloaded.");
    const response = await this.request(material);
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("File is larger than the 25 MB safety limit.");
    const disposition = response.headers.get("content-disposition") ?? "";
    const fromHeader = /filename\*?=(?:UTF-8''|\")?([^;\"]+)/i.exec(disposition)?.[1];
    const fromUrl = decodeURIComponent(material.pathname.split("/").at(-1) ?? "material");
    const filename = basename((fromHeader ? decodeURIComponent(fromHeader) : fromUrl).replace(/[\\/:*?"<>|]/g, "_"));
    const directory = resolve(outputDirectory);
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, filename);
    if (relative(directory, path).startsWith("..")) throw new Error("Unsafe download filename.");
    await writeFile(path, bytes, { flag: "wx" });
    return { path, bytes: bytes.length };
  }

  private sesskey(html: string): string {
    const fromInput = cheerio.load(html)("input[name=sesskey]").first().attr("value");
    const fromConfig = /"sesskey"\s*:\s*"([^\"]+)"/.exec(html)?.[1];
    const key = fromInput ?? fromConfig;
    if (!key) throw new Error("Could not find Moodle sesskey. The page layout may have changed.");
    return key;
  }

  private collectSubmissionForm(html: string): { action: string; fields: URLSearchParams } {
    const $ = cheerio.load(html);
    const form = $("form#mod_assign_submission_form, form[id^=mform]").first();
    if (!form.length) throw new Error("Moodle did not show a submission form. The assignment may not accept submissions.");
    const fields = new URLSearchParams();
    form.find("input[name], textarea[name], select[name]").each((_, element) => {
      const input = $(element);
      const name = input.attr("name");
      const type = (input.attr("type") ?? "").toLowerCase();
      if (!name || input.is(":disabled") || type === "file" || type === "submit" || type === "button") return;
      if ((type === "checkbox" || type === "radio") && !input.is(":checked")) return;
      const value = input.is("select") ? input.find("option:selected").attr("value") : input.val();
      fields.set(name, String(value ?? ""));
    });
    fields.set("submitbutton", "Save changes");
    return { action: this.absolute(form.attr("action") ?? "").href, fields };
  }

  private collectForm(html: string): { action: string; fields: URLSearchParams; draftItemId: string } {
    const { action, fields } = this.collectSubmissionForm(html);
    const draftItemId = fields.get("files")
      ?? fields.get("assignsubmission_file_filemanager")
      ?? fields.get("files_filemanager");
    if (!draftItemId || !/^\d+$/.test(draftItemId)) {
      throw new Error("This assignment does not expose the standard Moodle file-submission field.");
    }
    return { action, fields, draftItemId };
  }

  private async submissionForm(assignmentUrl: string): Promise<{ action: string; fields: URLSearchParams; html: string }> {
    await this.ensureLogin();
    const assignment = this.absolute(assignmentUrl);
    if (!assignment.pathname.includes("/mod/assign/view.php")) throw new Error("Use an assignment URL returned by list_assignments.");
    const editUrl = `${assignment.href}${assignment.search ? "&" : "?"}action=editsubmission`;
    const formPage = await this.page(editUrl);
    return { ...this.collectSubmissionForm(formPage), html: formPage };
  }

  private uploadRepositoryId(html: string): string {
    const repositories = /"repositories"\s*:\s*(\{.+?\})\s*,\s*"externallink"/s.exec(html)?.[1];
    if (!repositories) throw new Error("Moodle did not expose its file-upload repository.");
    const parsed = JSON.parse(repositories) as Record<string, { id?: string | number; type?: string }>;
    const upload = Object.values(parsed).find((repository) => repository.type === "upload");
    const id = upload?.id;
    if (id === undefined || !/^\d+$/.test(String(id))) {
      throw new Error("Moodle did not expose a usable file-upload repository.");
    }
    return String(id);
  }

  async submitAssignmentText(assignmentUrl: string, text: string): Promise<string> {
    const { action, fields } = await this.submissionForm(assignmentUrl);
    if (!fields.has("onlinetext_editor[text]")) {
      throw new Error("This assignment does not accept an online-text submission.");
    }
    fields.set("onlinetext_editor[text]", text.trim());
    const submitted = await this.request(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    const submittedHtml = await submitted.text();
    this.assertAuthenticated(submittedHtml, submitted);
    if (!submitted.ok || !/submitted for grading|submission status/i.test(submittedHtml)) {
      throw new Error("Moodle did not confirm the online-text submission. Verify it in the LMS.");
    }
    return "Online-text submission saved. Verify the timestamp and content in Moodle.";
  }

  async submitAssignmentFile(assignmentUrl: string, sourceFile: string): Promise<string> {
    const { action, fields, draftItemId, html: formPage } = await this.submissionForm(assignmentUrl).then((form) => {
      const draftItemId = form.fields.get("files")
        ?? form.fields.get("assignsubmission_file_filemanager")
        ?? form.fields.get("files_filemanager");
      if (!draftItemId || !/^\d+$/.test(draftItemId)) {
        throw new Error("This assignment does not expose the standard Moodle file-submission field.");
      }
      return { ...form, draftItemId };
    });
    const data = await import("node:fs/promises").then(({ readFile }) => readFile(resolve(sourceFile)));
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("Upload is larger than the 25 MB safety limit.");
    const fileName = basename(sourceFile);
    const form = new FormData();
    form.set("repo_id", this.uploadRepositoryId(formPage));
    form.set("p", "");
    form.set("page", "");
    form.set("env", "filemanager");
    form.set("filearea", "draft");
    form.set("itemid", draftItemId);
    form.set("ctx_id", /"contextid"\s*:\s*(\d+)/.exec(formPage)?.[1] ?? "1");
    form.set("sesskey", this.sesskey(formPage));
    form.set("savepath", "/");
    form.set("title", fileName);
    form.set("author", "");
    form.set("license", "allrightsreserved");
    form.set("repo_upload_file", new Blob([data]), fileName);
    const upload = await this.request("/repository/repository_ajax.php?action=upload", { method: "POST", body: form });
    const uploadText = await upload.text();
    if (!upload.ok || /error|exception/i.test(uploadText)) throw new Error(`Moodle rejected the file upload: ${compact(uploadText).slice(0, 300)}`);
    const submitted = await this.request(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    const submittedHtml = await submitted.text();
    this.assertAuthenticated(submittedHtml, submitted);
    if (!submitted.ok || !/submission status|submission files|submitted for grading/i.test(submittedHtml)) {
      throw new Error("Moodle did not confirm the submission. No success claim was made; verify it in the LMS.");
    }
    return `Submitted ${fileName}. Verify the timestamp and file in Moodle before the deadline.`;
  }
}
