// @ts-nocheck
import dotenv from "dotenv";
import { Command } from "commander";
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { JWT } from "google-auth-library";
import { GoogleSpreadsheet } from "google-spreadsheet";
import {
  applySpec,
  evolve,
  groupBy,
  head,
  keys,
  // last,
  map,
  omit,
  pick,
  pipe,
  prop,
  sortBy,
  split,
  sum,
  toPairs,
  values,
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
  "1bksMCq5oPixzHLeDXWuuU32RVUUNfjkCZWm-jzjQYDw",
  serviceAccountAuth
);

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

async function main() {
  // Get command line args
  program.parse(process.argv);
  const programOptions = program.opts();
  const filePath = programOptions.file;

  if (!filePath) {
    console.error(
      "Error: You must provide a path to the file using -f or --file option."
    );
    process.exit(1);
  }

  // Parse CSV file
  const jiraCSV = readFileSync(filePath, "utf-8");
  const parsedJira = parse(jiraCSV, {
    columns: true,
    relax_quotes: true,
  });

  // Create worklogs in Google Sheets format
  const currentMonthWorklogs = pipe(
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
    sortBy((obj) => obj.Dia.split("/")[0])
  )(parsedJira);

  const currentMonth = getMonthName(
    Number(currentMonthWorklogs[0].Dia.split("/")[1])
  );
  // TODO: Create totals row and format it properly
  // const totalsRow = last(rows);
  // totalsRow.set("Dia", `Total ${currentMonth}:`);
  // currentMonthWorklogs.push(totalsRow);

  // Load Google Sheets document
  await doc.loadInfo();
  const sheet = doc.sheetsById[process.env.SHEET_ID];
  // const rows = await sheet.getRows();

  if (programOptions.write) {
    await sheet.addRows(currentMonthWorklogs);
  }

  if (programOptions.print) {
    console.log(currentMonthWorklogs);
  }
}

main();
