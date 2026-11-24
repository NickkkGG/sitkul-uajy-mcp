import { describe, expect, it } from "vitest";
import { MoodleClient } from "../src/moodle.js";

const ASSIGNMENT_PAGE = `
<div id="region-main">
  <h1>Validasi data</h1>
  <div id="intro">Kerjakan modul.</div>
  <table class="generaltable">
    <tr><th>Submission status</th><td>Submitted for grading</td></tr>
    <tr><th>Grading status</th><td>Not graded</td></tr>
    <tr><th>Last modified</th><td>Tuesday, 17 November 2026, 11:29 PM</td></tr>
    <tr><th>File submissions</th><td>
      <div class="fileuploadsubmission">
        <a target="_blank" href="https://kuliah.uajy.ac.id/pluginfile.php/1/assignsubmission_file/submission_files/9/laporan.pdf?forcedownload=1">laporan.pdf</a>
        <div class="fileuploadsubmissiontime">17 November 2026, 11:29 PM</div>
      </div>
      <div class="fileuploadsubmission">
        <a target="_blank" href="https://kuliah.uajy.ac.id/pluginfile.php/1/assignsubmission_file/submission_files/9/data.zip?forcedownload=1">data.zip</a>
      </div>
    </td></tr>
    <tr><th>Submission comments</th><td><a href="#">Comments (0)</a></td></tr>
  </table>
  <button>Edit submission</button>
</div>`;

function clientWithPage(html: string): MoodleClient {
  const client = new MoodleClient("user", "pass");
  (client as unknown as { page(path: string): Promise<string> }).page = async () => html;
  return client;
}

describe("MoodleClient.getAssignmentDetails", () => {
  it("returns the names of the files in the current submission", async () => {
    const details = await clientWithPage(ASSIGNMENT_PAGE).getAssignmentDetails(
      "https://kuliah.uajy.ac.id/mod/assign/view.php?id=1",
    );
    expect(details.submissionStatus).toBe("Submitted for grading");
    expect(details.fileSubmissions).toEqual(["laporan.pdf", "data.zip"]);
    expect(details.canSubmit).toBe(true);
  });

  it("returns an empty list when nothing has been submitted", async () => {
    const page = ASSIGNMENT_PAGE.replace(/<tr><th>File submissions<\/th>[\s\S]*?<\/td><\/tr>/, "");
    const details = await clientWithPage(page).getAssignmentDetails(
      "https://kuliah.uajy.ac.id/mod/assign/view.php?id=1",
    );
    expect(details.fileSubmissions).toEqual([]);
  });
});
