import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MoodleClient } from "./moodle.js";

const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const failure = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] });

export function createServer(): McpServer {
  const moodle = new MoodleClient(process.env.SITKUL_USERNAME, process.env.SITKUL_PASSWORD);
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
    description: "List downloadable Moodle files in one enrolled course.",
    inputSchema: { course_id: z.string().describe("Course ID from list_courses") },
    annotations: { readOnlyHint: true },
  }, async ({ course_id }) => { try { return result(await moodle.listMaterials(course_id)); } catch (error) { return failure(error); } });

  server.registerTool("download_material", {
    title: "Unduh materi",
    description: "Download a material URL returned by list_materials to the MCP host's downloads folder.",
    inputSchema: { material_url: z.string().url().describe("Exact URL returned by list_materials") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ material_url }) => {
    try {
      const directory = process.env.SITKUL_DOWNLOAD_DIR ?? "./downloads";
      return result(await moodle.downloadMaterial(material_url, directory));
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
