import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CanvaClient } from "./canva.js";
import { MoodleClient } from "./moodle.js";

const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });

function isCanvaUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "canva.link" || host === "canva.com" || host.endsWith(".canva.com");
  } catch {
    return false;
  }
}

function canvaHandoff(targetUrl: string) {
  return {
    provider: "canva",
    targetUrl,
    preferredFormat: "pdf",
    sameChat: {
      nextMcpServer: "sitkul-uajy",
      nextTool: "download_canva_material",
      input: { canva_url: targetUrl, format: "pdf" },
      requirement: "Run canva_connection_status first. If it is not connected, configure the one-time Canva OAuth connection with connect_canva.",
    },
    alternateCanvaMcp: {
      nextMcpServer: "canva",
      nextActions: [
        "Use Canva MCP resolve-shortlink with targetUrl.",
        "Use Canva MCP get-export-formats for the resolved design.",
        "Use Canva MCP export-design in PDF format, then download its signed URL immediately.",
      ],
    },
  };
}

export function createServer(): McpServer {
  const moodle = new MoodleClient(process.env.SITKUL_USERNAME, process.env.SITKUL_PASSWORD);
  const canva = new CanvaClient();
  const server = new McpServer({ name: "sitkul-uajy", version: "0.1.0" });

  server.registerTool("list_courses", {
    title: "Daftar mata kuliah",
    description: "List enrolled UAJY Moodle courses for the configured student account.",
    annotations: { readOnlyHint: true },
  }, async () => { try { return result(await moodle.listCourses()); } catch (error) { return failure(error); } });

  server.registerTool("list_assignments", {
    title: "Daftar tugas",
    description: "List assignment activities, optionally for one enrolled course ID.",
    inputSchema: { course_id: z.string().optional().describe("Course ID from list_courses") },
    annotations: { readOnlyHint: true },
  }, async ({ course_id }) => { try { return result(await moodle.listAssignments(course_id)); } catch (error) { return failure(error); } });

  server.registerTool("list_deadlines", {
    title: "Cek deadline tugas",
    description: "Read assignment deadline pages and return due dates, sorted from nearest to furthest.",
    inputSchema: { course_id: z.string().optional().describe("Course ID from list_courses") },
    annotations: { readOnlyHint: true },
  }, async ({ course_id }) => { try { return result(await moodle.listDeadlines(course_id)); } catch (error) { return failure(error); } });

  server.registerTool("get_assignment_details", {
    title: "Detail tugas",
    description: "Open one Moodle assignment and return its instructions, deadline, submission status, grading status, and whether it can still be submitted.",
    inputSchema: { assignment_url: z.string().url().describe("Exact assignment URL returned by list_assignments") },
    annotations: { readOnlyHint: true },
  }, async ({ assignment_url }) => { try { return result(await moodle.getAssignmentDetails(assignment_url)); } catch (error) { return failure(error); } });

  server.registerTool("list_assignment_attachments", {
    title: "Daftar lampiran tugas",
    description: "List downloadable files attached to a Moodle assignment description.",
    inputSchema: { assignment_url: z.string().url().describe("Exact assignment URL returned by list_assignments") },
    annotations: { readOnlyHint: true },
  }, async ({ assignment_url }) => { try { return result(await moodle.listAssignmentAttachments(assignment_url)); } catch (error) { return failure(error); } });

  server.registerTool("list_materials", {
    title: "Daftar materi kuliah",
    description: "List Moodle files, resources, and external linked materials in one enrolled course. URL activities include their resolved destination when available.",
    inputSchema: { course_id: z.string().describe("Course ID from list_courses") },
    annotations: { readOnlyHint: true },
  }, async ({ course_id }) => {
    try {
      const materials = await moodle.listMaterials(course_id);
      return result({
        materials: materials.map((material) => (
          material.kind === "link" && material.targetUrl && isCanvaUrl(material.targetUrl)
            ? { ...material, handoff: canvaHandoff(material.targetUrl) }
            : material
        )),
        note: "For Canva links, prefer handoff.sameChat with download_canva_material so the existing Sitkul MCP can complete the export in this chat. The alternate Canva MCP flow is optional.",
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool("prepare_material_download", {
    title: "Siapkan unduhan materi",
    description: "Determine whether a Moodle material should be downloaded directly or handed off to another connected MCP, such as Canva. This tool does not download or export anything itself.",
    inputSchema: { material_url: z.string().url().describe("Exact Moodle material URL returned by list_materials") },
    annotations: { readOnlyHint: true },
  }, async ({ material_url }) => {
    try {
      if (moodle.isDownloadableMaterialUrl(material_url)) {
        return result({ provider: "moodle", nextMcpServer: "sitkul-uajy", nextTool: "download_material", input: { material_url } });
      }
      const targetUrl = await moodle.resolveExternalMaterialLink(material_url);
      if (isCanvaUrl(targetUrl)) return result(canvaHandoff(targetUrl));
      return result({ provider: "external", targetUrl, note: "Open this link with an appropriate connected MCP or browser; it is not a Moodle-downloadable file." });
    } catch (error) { return failure(error); }
  });

  server.registerTool("download_material", {
    title: "Unduh materi",
    description: "Download a Moodle file or resource URL returned by list_materials to the MCP host's downloads folder. External link materials must be opened at their target URL and may require that provider's login.",
    inputSchema: { material_url: z.string().url().describe("Exact URL returned by list_materials") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ material_url }) => {
    try {
      const directory = process.env.SITKUL_DOWNLOAD_DIR ?? "./downloads";
      return result(await moodle.downloadMaterial(material_url, directory));
    } catch (error) { return failure(error); }
  });

  server.registerTool("canva_connection_status", {
    title: "Status koneksi Canva",
    description: "Check whether Canva OAuth has been configured and connected on this MCP host.",
    annotations: { readOnlyHint: true },
  }, async () => { try { return result(await canva.connectionStatus()); } catch (error) { return failure(error); } });

  server.registerTool("connect_canva", {
    title: "Hubungkan akun Canva",
    description: "Start the one-time Canva OAuth connection and open the authorization page in the default browser. Sign in yourself and approve read/export access. After the callback, the local page closes when the browser permits it. No Canva password is stored by this MCP.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async () => { try { return result(await canva.beginConnection()); } catch (error) { return failure(error); } });

  server.registerTool("download_canva_material", {
    title: "Unduh materi Canva",
    description: "Export a Canva link returned by list_materials as PDF or PPTX using the connected Canva account, then save it in the MCP host's downloads folder.",
    inputSchema: {
      canva_url: z.string().url().describe("The targetUrl for a Canva link returned by list_materials"),
      format: z.enum(["pdf", "pptx"]).default("pdf").describe("PDF is recommended for reading; PPTX is for editable slides"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ canva_url, format }) => {
    try {
      const directory = process.env.SITKUL_DOWNLOAD_DIR ?? "./downloads";
      return result(await canva.downloadDesign(canva_url, format, directory));
    } catch (error) { return failure(error); }
  });

  server.registerTool("submit_assignment_file", {
    title: "Kumpulkan file tugas",
    description: "Upload a local file as the student's submission to a Moodle assignment. It cannot create or change course materials.",
    inputSchema: {
      assignment_url: z.string().url().describe("Exact assignment URL returned by list_assignments"),
      source_file: z.string().describe("Absolute path to the file on the MCP host"),
      confirm_submit: z.literal(true).describe("Must be true immediately before submitting"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ assignment_url, source_file }) => {
    try { return result({ message: await moodle.submitAssignmentFile(assignment_url, source_file) }); } catch (error) { return failure(error); }
  });

  server.registerTool("submit_assignment_text", {
    title: "Kumpulkan teks atau tautan tugas",
    description: "Save text, such as a Google Colab link, as the student's Moodle online-text assignment submission.",
    inputSchema: {
      assignment_url: z.string().url().describe("Exact assignment URL returned by list_assignments"),
      text: z.string().min(1).describe("Text or link to submit"),
      confirm_submit: z.literal(true).describe("Must be true immediately before submitting"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ assignment_url, text }) => {
    try { return result({ message: await moodle.submitAssignmentText(assignment_url, text) }); } catch (error) { return failure(error); }
  });

  return server;
}
