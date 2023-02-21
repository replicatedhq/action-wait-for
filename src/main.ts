import * as core from "@actions/core";
import * as github from "@actions/github";
import { Endpoints } from "@octokit/types";

type CheckRun =
  Endpoints["GET /repos/{owner}/{repo}/commits/{ref}/check-runs"]["response"]["data"]["check_runs"][0];

async function run(): Promise<void> {
  try {
    // get and validate the inputs
    const timeout =
      parseInt(core.getInput("timeout", { required: true }), 10) * 1000;
    if (isNaN(timeout)) {
      throw new Error("timeout must be a number");
    }

    const interval =
      parseInt(core.getInput("interval", { required: true }), 10) * 1000;
    if (isNaN(interval)) {
      throw new Error("interval must be a number");
    }

    const token = core.getInput("token", { required: true });
    const ref = core.getInput("ref", { required: true });
    const check_name = core.getInput("check-name");
    const check_regexp = core.getInput("check-regexp");

    // set the filterFunc based on the inputs
    let filterFunc: (el: CheckRun) => boolean;
    if (check_regexp !== "") {
      const regexp = new RegExp(check_regexp);
      filterFunc = (item: CheckRun) => regexp.test(item.name);
    } else {
      filterFunc = () => true;
    }

    // setup the github client
    const octokit = github.getOctokit(token);

    // wait for the checks to complete
    let checkTimeout: NodeJS.Timeout | undefined;
    let checkInterval: NodeJS.Timer | undefined;
    let checking = false;
    try {
      await Promise.race([
        new Promise(
          (_, reject) =>
            // reject the race if the timeout is reached
            (checkTimeout = setTimeout(reject, timeout, "timeout"))
        ),
        new Promise<void>((resolve, reject) => {
          // poll for checks at the provided interval
          try {
            checkInterval = setInterval(async () => {
              // only run one check at a time
              if (checking) return;
              checking = true;

              try {
                // get the checks for the provided ref, filtered by the check_name or regexp
                core.info(`Checking for active checks on ${ref}...`);
                const checks = (
                  await octokit.paginate(octokit.rest.checks.listForRef, {
                    ...github.context.repo,
                    ref,
                    per_page: 100,
                    check_name,
                  })
                )
                  .filter((check) => check.name !== github.context.job) // ignore the current job
                  .filter(filterFunc);

                // if there are no checks at all, assume a race condition and wait
                if (checks.length === 0) {
                  core.info("No matching checks found, waiting...");
                  return;
                }

                // split the checks list inti complete and incomplete
                core.info(`Found ${checks.length} matching checks...`);
                const [complete, incomplete] = [
                  checks.filter((check) => check.status === "completed"),
                  checks.filter((check) => check.status !== "completed"),
                ];

                // if all checks are complete, check the conclusions
                if (incomplete.length === 0) {
                  core.info("All checks have completed, checking statuses...");

                  // find any unsuccessful checks
                  const goodConclusions: (string | null)[] = [
                    "success",
                    "skipped",
                  ];
                  const bad = complete.filter(
                    (check) => !goodConclusions.includes(check.conclusion)
                  );
                  if (bad.length > 0) {
                    // if there are any unsuccessful checks, fail the action
                    throw new Error(
                      `Some checks failed: ${bad
                        .map((check) => check.details_url)
                        .join(", ")}`
                    );
                  }
                  // If we reach this point, all checks have completed successfully.
                  core.info("All checks have completed successfully.");
                  resolve();
                } else {
                  // if there are incomplete checks, end this poll and wait for the next one
                  core.info(
                    `Waiting for ${
                      incomplete.length
                    } checks to complete: [ ${incomplete
                      .map((check) => check.name)
                      .join(", ")} ]`
                  );
                  return;
                }
              } finally {
                checking = false;
              }
            }, interval);
          } catch (error) {
            reject(error);
          }
        }),
      ]);
    } finally {
      if (checkInterval) {
        clearInterval(checkInterval);
      }
      if (checkTimeout) {
        clearTimeout(checkTimeout);
      }
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message);
  }
  core.info("the real end, really");
}

run();
