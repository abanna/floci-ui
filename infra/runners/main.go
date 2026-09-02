// gh-runners: GitHub-side resources for the 3 self-hosted runners on Cloudflare.
//
// The Cloudflare side (Worker + 3 container instances) is deployed out-of-band
// via the Cloudflare API — see README ("API deploy recipe") — because
// pulumi-cloudflare has no Containers resources and the wrangler-in-Pulumi
// step needed an API token with account-wide scope. This program manages only
// the GitHub side: the org workflow_job webhook (created after you add
// admin:org_hook to the token) and the optional runner group.
package main

import (
	"github.com/pulumi/pulumi-github/sdk/v6/go/github"
	"github.com/pulumi/pulumi-random/sdk/v4/go/random"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")

		org := cfg.Get("ghOrg")
		if org == "" {
			org = "nerds-run"
		}
		workerURL := cfg.Require("webhookUrl") // e.g. https://nerds-run-gh-runners.solvedgg.workers.dev
		githubToken := cfg.RequireSecret("githubToken").ToStringOutput()

		// Webhook secret: pinned via `pulumi config set --secret webhookSecret`.
		var webhookSecret pulumi.StringOutput
		pinned, err := cfg.TrySecret("webhookSecret")
		if err != nil {
			whSecret, err := random.NewRandomPassword(ctx, "webhookSecret", &random.RandomPasswordArgs{
				Length:  pulumi.Int(40),
				Special: pulumi.Bool(false),
			})
			if err != nil {
				return err
			}
			webhookSecret = whSecret.Result.ToStringOutput()
		} else {
			webhookSecret = pinned
		}

		ghProvider, err := github.NewProvider(ctx, "gh", &github.ProviderArgs{
			Token:        githubToken,
			Organization: pulumi.String(org),
		})
		if err != nil {
			return err
		}

		wh, err := github.NewOrganizationWebhook(ctx, "workflowJobWebhook", &github.OrganizationWebhookArgs{
			Configuration: &github.OrganizationWebhookConfigurationArgs{
				Url:         pulumi.Sprintf("%s/webhook", workerURL).ToStringOutput(),
				ContentType: pulumi.String("json"),
				InsecureSsl: pulumi.Bool(false),
				Secret:      webhookSecret,
			},
			Events: pulumi.StringArray{pulumi.String("workflow_job")},
			Active: pulumi.Bool(true),
		}, pulumi.Provider(ghProvider))
		if err != nil {
			return err
		}

		// Optional runner group: set `pulumi config set runnerGroup cloudflare`.
		// Note: for runners to land in it, also set RUNNER_GROUP in worker/wrangler.jsonc.
		if groupName := cfg.Get("runnerGroup"); groupName != "" {
			_, err := github.NewActionsRunnerGroup(ctx, "runnerGroup", &github.ActionsRunnerGroupArgs{
				Name:       pulumi.String(groupName),
				Visibility: pulumi.String("selected"),
			}, pulumi.Provider(ghProvider))
			if err != nil {
				return err
			}
		}

		ctx.Export("workerUrl", pulumi.String(workerURL))
		ctx.Export("webhookUrl", wh.Url)
		ctx.Export("webhookSecret", webhookSecret)
		return nil
	})
}
