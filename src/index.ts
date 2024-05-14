// @ts-nocheck
import dotenv from "dotenv";
import { Command } from "commander";
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { JWT } from "google-auth-library";
import { GoogleSpreadsheet } from "google-spreadsheet";
import qs from "qs";
import {
  applySpec,
  chain,
  filter,
  evolve,
  groupBy,
  head,
  keys,
  last,
  map,
  omit,
  pick,
  pipe,
  prop,
  propOr,
  sortBy,
  split,
  sum,
  toPairs,
  values,
  tap,
  path,
  reduce,
  has,
  join,
  uniq,
  add,
  modify,
  partition,
} from "ramda";

// ENV CONFIG
dotenv.config();

// COMMANDER CONFIGS
const program = new Command();
program.version("1.0.0");
program.option("-f, --file <filePath>", "Specify the path to the file");
program.option("-w, --write", "Write results to googlesheets");
program.option("-p, --print", "Print results to console");

// GOOGLE SHEETS CONFIG
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join("\n"),
  scopes: SCOPES,
});
const doc = new GoogleSpreadsheet(
  process.env.GOOGLE_SPREADSHEET_ID,
  serviceAccountAuth
);

// JIRA CONFIG
const JIRA_CONNECTION_STRING = `${process.env.JIRA_EMAIL}:${process.env.JIRA_TOKEN}`;

// HELPER FUNCTIONS
function convertDateFormat(dateString) {
  // Split the input string into day, month, and year parts
  const [day, month, year] = dateString.split("-");

  // Create a new Date object using the components (month is zero-based in Date)
  const dateObject = new Date(`${month} ${day}, ${year}`);

  // Format the date using Date methods
  const formattedDay = ("0" + dateObject.getDate()).slice(-2);
  const formattedMonth = ("0" + (dateObject.getMonth() + 1)).slice(-2); // Adding 1 to month since January is 0
  const formattedYear = dateObject.getFullYear();

  // Return the formatted date string
  return `${formattedDay}/${formattedMonth}/${formattedYear}`;
}

function formatDate(date) {
  // Extract day, month, and year from the Date object
  const day = date.getDate().toString().padStart(2, "0"); // Add leading zero if needed
  const month = (date.getMonth() + 1).toString().padStart(2, "0"); // Add leading zero if needed
  const year = date.getFullYear();

  // Return formatted date string in DD/MM/YYYY format
  return `${day}/${month}/${year}`;
}

function getMonthName(monthNumber) {
  const monthNames = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro",
  ];

  return monthNames[monthNumber - 1];
}

const now = new Date();
function isInPreviousMonth(date) {
  const prevMonth = (now.getMonth() + 11) % 12; // Get the index of the previous month by going 11 months in the future
  const prevMonthYear =
    prevMonth === 11 ? now.getFullYear() - 1 : now.getFullYear(); // Subtract 1 year if previous month is December
  return date.getMonth() === prevMonth && date.getFullYear() === prevMonthYear;
}

function getPreviousMonthTimestamps() {
  // Get the current date
  const now = new Date();

  // Set to the first day of the current month
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Set to the first day of the previous month
  const startOfPreviousMonth = new Date(startOfCurrentMonth);
  startOfPreviousMonth.setMonth(startOfCurrentMonth.getMonth() - 1);

  // Convert to UNIX timestamps
  const startTimestamp = Math.floor(startOfPreviousMonth.getTime() / 1000);
  const endTimestamp = Math.floor(startOfCurrentMonth.getTime() / 1000);

  return {
    start: startTimestamp,
    end: endTimestamp,
  };
}

async function fetchPreviousMonthWorklog(issue) {
  const { startTimestamp, endTimestamp } = getPreviousMonthTimestamps();

  const url = `https://${process.env.JIRA_ORG}.atlassian.net/rest/api/2/issue/${prop("key", issue)}/worklog?${qs.stringify(
    {
      maxResults: 5000,
      startAt: 0,
      startedAfter: startTimestamp,
      startedBefore: endTimestamp,
    }
  )}`;
  const options = {
    method: "GET",
    headers: {
      "Authorization": `Basic ${Buffer.from(JIRA_CONNECTION_STRING).toString(
        "base64"
      )}`,
      "Accept": "application/json",
    },
  };

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(
      `Error fetching worklog for ${prop("key", issue)}: ${response.statusText}`
    );
  }

  const data = await response.json();
  return {
    id: prop("id", issue),
    project: path(["fields", "project", "name"], issue),
    key: prop("key", issue),
    summary: path(["fields", "summary"], issue),
    worklogs: prop("worklogs", data),
  };
}

async function main() {
  // Get command line args
  program.parse(process.argv);
  const programOptions = program.opts();
  const filePath = programOptions.file;

  let spreadsheetWorklogs = [];

  // File was provided
  if (has("file", programOptions)) {
    if (!filePath) {
      console.error(
        "Error: You must provide a path to the file using -f or --file option."
      );
      return;
    }

    // Parse CSV file
    const jiraCSV = readFileSync(filePath, "utf-8");
    const parsedJira = parse(jiraCSV, {
      columns: true,
      relax_quotes: true,
    });

    // Create worklogs in Google Sheets format
    const csvFileWorklogs = pipe(
      map(
        pick([
          "Project Name",
          "Summary",
          "Hr. Spent",
          "Log Date & Time",
          "Ticket No",
        ])
      ),
      map(
        evolve({
          "Log Date & Time": pipe(split(" "), head),
        })
      ),
      groupBy(prop("Log Date & Time")),
      map(map(omit(["Log Date & Time"]))),
      map(
        map(
          applySpec({
            taskName: (obj) =>
              `${prop("Project Name")(obj)}:[${prop("Ticket No")(obj)}] ${prop("Summary")(obj)}`,
            hours: prop("Hr. Spent"),
          })
        )
      ),
      map(groupBy(prop("taskName"))),
      map(
        map((el) =>
          el?.reduce(
            (acc, curr) => {
              acc.hours = acc.hours + Number(prop("hours", curr));
              return { ...acc };
            },
            { hours: 0 }
          )
        )
      ),
      toPairs,
      map(([date, tasks]) => ({
        Dia: convertDateFormat(date),
        Atividade: keys(tasks).join("\n"),
        "Horas trabalhadas": pipe(
          values,
          map(prop("hours")),
          sum,
          (hours) => hours / 24
        )(tasks),
      })),
      sortBy((worklogRow) => worklogRow.Dia.split("/")[0])
    )(parsedJira);

    spreadsheetWorklogs = csvFileWorklogs;
  }

  // No file was provided, attempt to use previous month's data from Jira
  if (!has("file", programOptions)) {
    // Get data from Jira API
    const JQL_QUERY = `(worklogAuthor in ("${process.env.JIRA_ACCOUNT_ID}")) AND (worklogDate >= startOfMonth(-1) and worklogDate <= endOfMonth(-1))`;
    try {
      const res = await fetch(
        `https://${process.env.JIRA_ORG}.atlassian.net/rest/api/2/search?${qs.stringify({ jql: JQL_QUERY, fields: ["summary", "worklog", "project"], maxResults: 5000 }, { arrayFormat: "comma" })}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Basic ${Buffer.from(
              JIRA_CONNECTION_STRING
            ).toString("base64")}`,
            "Accept": "application/json",
          },
        }
      );
      const parsedJiraResponse = await res.json();
      const issues = propOr([], "issues", parsedJiraResponse);
      const [issuesWithWorklogOverflow, issuesWithoutWorklogOverflow] =
        partition(
          (issue) =>
            issue.fields.worklog.total > issue.fields.worklog.maxResults,
          issues
        );

      const fetchOverflowWorklogs = map(fetchPreviousMonthWorklog)(
        issuesWithWorklogOverflow
      );
      const parsedIssuesWithWorklogOverflow = await Promise.all(
        fetchOverflowWorklogs
      );

      const parsedIssuesWithoutWorklogOverflow = map(
        applySpec({
          id: prop("id"),
          project: path(["fields", "project", "name"]),
          key: prop("key"),
          summary: path(["fields", "summary"]),
          worklogs: pipe(path(["fields", "worklog", "worklogs"])),
        })
      )(issuesWithoutWorklogOverflow);

      const allIssues = [
        ...parsedIssuesWithWorklogOverflow,
        ...parsedIssuesWithoutWorklogOverflow,
      ];

      const previousMonthWorklogs = pipe(
        map(
          modify(
            "worklogs",
            map((worklog) => ({
              ...worklog,
              author: worklog.author.displayName,
              authorId: worklog.author.accountId,
              started: new Date(worklog.started),
            }))
          )
        ),
        chain((issue) =>
          pipe(
            propOr([], "worklogs"),
            map((worklog) => ({
              ...omit(["worklogs"], issue),
              ...omit(
                [
                  "self",
                  "updateAuthor",
                  "created",
                  "updated",
                  "comment",
                  "timeSpent",
                ],
                worklog
              ),
            }))
          )(issue)
        ),
        filter((worklog) => worklog.authorId === process.env.JIRA_ACCOUNT_ID),
        filter((worklog) => isInPreviousMonth(worklog.started)),
        map((worklog) => ({
          ...worklog,
          started: formatDate(worklog.started),
        })),
        map(
          applySpec({
            id: prop("id"),
            issueId: prop("issueId"),
            started: prop("started"),
            taskName: (obj) =>
              `${prop("project")(obj)}: [${prop("key")(obj)}] ${prop("summary")(obj)}`,
            timeSpentSeconds: prop("timeSpentSeconds"),
          })
        ),
        groupBy(prop("started")),
        map(
          reduce(
            (acc, current) => ({
              tasks: [...acc.tasks, current.taskName],
              timeSpentSeconds: acc.timeSpentSeconds + current.timeSpentSeconds,
            }),
            { tasks: [], timeSpentSeconds: 0 }
          )
        ),
        toPairs,
        map(([date, task]) => ({ ...task, date })),
        map(
          applySpec({
            Dia: prop("date"),
            Atividade: pipe(prop("tasks"), uniq, join("\n")),
            "Horas trabalhadas": pipe(
              prop("timeSpentSeconds"),
              (timeSpentSeconds) => timeSpentSeconds / 60 / 60 / 24
            ),
          })
        ),
        sortBy((worklogRow) => worklogRow.Dia.split("/")[0])
      )(allIssues);

      spreadsheetWorklogs = previousMonthWorklogs;
    } catch (error) {
      console.error("Failed processing worklogs from Jira", error);
      return;
    }
  }

  if (programOptions.write) {
    try {
      // Load Google Sheets document
      await doc.loadInfo();
      const sheet = doc.sheetsById[process.env.GOOGLE_SHEET_ID];
      const rows = await sheet.getRows();

      const firstWorklogRowNumber = pipe(
        last,
        prop("_rowNumber"),
        add(1)
      )(rows);
      const lastWorklogRowNumber =
        firstWorklogRowNumber + spreadsheetWorklogs.length - 1;

      const totalsMonth = getMonthName(
        spreadsheetWorklogs[0].Dia.split("/")[1]
      );

      const totalsRow = {
        Dia: `Total ${totalsMonth}:`,
        Atividade: "",
        "Horas trabalhadas": `=SUM(C${firstWorklogRowNumber}:C${lastWorklogRowNumber})`,
      };

      spreadsheetWorklogs.push(totalsRow);

      await sheet.addRows(spreadsheetWorklogs);

      // Format last row
      await sheet.loadCells(
        `A${lastWorklogRowNumber + 1}:C${lastWorklogRowNumber + 1}`
      );
      const formatOptions = {
        backgroundColor: {
          red: 1,
          green: 153 / 255,
          blue: 0,
        },
        textFormat: {
          fontFamily: "Arial",
          bold: true,
        },
      };

      const lastRowCellA = sheet.getCellByA1(`A${lastWorklogRowNumber + 1}`);
      const lastRowCellC = sheet.getCellByA1(`C${lastWorklogRowNumber + 1}`);

      lastRowCellA.textFormat = formatOptions.textFormat;
      lastRowCellA.backgroundColor = formatOptions.backgroundColor;
      lastRowCellC.backgroundColor = formatOptions.backgroundColor;

      await sheet.saveUpdatedCells();

      // Merge last row cells [start, end)
      await sheet.mergeCells({
        "startRowIndex": lastWorklogRowNumber,
        "endRowIndex": lastWorklogRowNumber + 1,
        "startColumnIndex": 0,
        "endColumnIndex": 2,
      });
    } catch (error) {
      console.error("Failed writing worklogs to Google Sheets", error);
    }
  }

  if (programOptions.print) {
    console.log(spreadsheetWorklogs);
  }
}

main();
