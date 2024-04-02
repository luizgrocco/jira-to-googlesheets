// @ts-nocheck
import { readFileSync } from "fs";
import { parse } from "csv-parse/sync";
import dotenv from "dotenv";
import { JWT } from "google-auth-library";
import { GoogleSpreadsheet } from "google-spreadsheet";
import {
  applySpec,
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
  sortBy,
  split,
  sum,
  toPairs,
  values,
} from "ramda";

dotenv.config();

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
  await doc.loadInfo();
  const sheet = doc.sheetsById[process.env.SHEET_ID];
  const rows = await sheet.getRows();

  const jiraFile = readFileSync("./src/Grouped - [User daywise].csv", "utf-8");
  const parsedJira = parse(jiraFile, {
    columns: true,
    relax_quotes: true,
  });
  const output = pipe(
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

  const currentMonth = getMonthName(Number(output[0].Dia.split("/")[1]));
  const totalsRow = last(rows);
  totalsRow.set("Dia", `Total ${currentMonth}:`);
  output.push(totalsRow);

  console.log(output);

  // await sheet.addRows(output);
}

main();
