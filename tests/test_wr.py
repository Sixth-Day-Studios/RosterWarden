"""wr.py's deploy gate, checked with a stand-in for git and the test run, so nothing is ever deployed:
a deploy goes ahead only from a clean main whose tests pass, says why when it won't, and --force overrides.

    python tests/test_wr.py
"""
import io
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wr  # noqa: E402  (after the path tweak above)


class FakeRun:
    """Stands in for subprocess.run: answers git with a chosen branch and status, and the tests with a result."""

    def __init__(self, branch="main", status="", tests_pass=True, head="aaa", origin_main="bbb"):
        """Set what git reports (branch, changes, this commit and origin/main's) and whether the test run passes."""
        self.branch, self.status, self.tests_pass = branch, status, tests_pass
        self.head, self.origin_main = head, origin_main
        self.commands = []

    def __call__(self, cmd, **kwargs):
        """Record the command and answer it like the real one would."""
        self.commands.append(cmd)
        if cmd == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=self.head + "\n")
        if cmd == ["git", "rev-parse", "origin/main"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=self.origin_main + "\n")
        if cmd[:2] == ["git", "rev-parse"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=self.branch + "\n")
        if cmd[:2] == ["git", "status"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=self.status)
        if cmd == wr.TEST_COMMAND:
            return subprocess.CompletedProcess(cmd, 0 if self.tests_pass else 1)
        raise AssertionError(f"unexpected command: {cmd}")


class DeployGateTest(unittest.TestCase):
    """deploy_problems and may_deploy, against FakeRun."""

    def test_clean_main_with_passing_tests_may_deploy(self):
        """Nothing wrong: no problems, and the tests were actually run."""
        run = FakeRun()
        self.assertEqual(wr.deploy_problems(run, io.StringIO()), [])
        self.assertIn(wr.TEST_COMMAND, run.commands)
        self.assertTrue(wr.may_deploy(False, run, out=io.StringIO()))

    def test_another_branch_is_refused_without_running_the_tests(self):
        """Not on main: refused, named, and the slow test run is skipped."""
        run = FakeRun(branch="audit-fixes")
        problems = wr.deploy_problems(run, io.StringIO())
        self.assertEqual(len(problems), 1)
        self.assertIn("'audit-fixes', not main", problems[0])
        self.assertNotIn(wr.TEST_COMMAND, run.commands)

    def test_another_branch_at_mains_own_commit_may_deploy(self):
        """A worktree that can't check main out, but sits at the commit origin/main is at: allowed."""
        run = FakeRun(branch="HEAD", head="abc", origin_main="abc")
        self.assertEqual(wr.deploy_problems(run, io.StringIO()), [])
        self.assertIn(wr.TEST_COMMAND, run.commands)

    def test_worker_deploy_always_uses_the_workers_own_config(self):
        """worker-deploy runs in worker/ with --config, so it can never redeploy the app by mistake."""
        args, cwd = wr.worker_deploy(["worker-deploy", "--dry-run"])
        self.assertEqual(args, ["deploy", "--config", "wrangler.toml", "--dry-run"])
        self.assertEqual(cwd, os.path.join(wr.HERE, "worker"))
        self.assertIsNone(wr.worker_deploy(["deploy"]))

    def test_uncommitted_changes_are_refused_and_listed(self):
        """A dirty tree, untracked files included: refused, with the files shown."""
        run = FakeRun(status=" M wr.py\n?? js/new.js\n")
        problems = wr.deploy_problems(run, io.StringIO())
        self.assertEqual(len(problems), 1)
        self.assertIn("uncommitted changes", problems[0])
        self.assertIn("?? js/new.js", problems[0])

    def test_failing_tests_are_refused(self):
        """Clean main but a failing suite: refused."""
        self.assertIn("the tests fail", wr.deploy_problems(FakeRun(tests_pass=False), io.StringIO())[0])

    def test_refusal_says_why_and_how_to_override(self):
        """may_deploy says no, giving every reason and the --force way round."""
        out = io.StringIO()
        self.assertFalse(wr.may_deploy(False, FakeRun(branch="x", status=" M a\n"), out=out))
        message = out.getvalue()
        self.assertIn("Not deploying", message)
        self.assertIn("'x', not main", message)
        self.assertIn("uncommitted changes", message)
        self.assertIn("--force", message)

    def test_force_deploys_anyway_but_still_warns(self):
        """--force goes ahead, still naming what it overrode."""
        out = io.StringIO()
        self.assertTrue(wr.may_deploy(True, FakeRun(tests_pass=False), out=out))
        self.assertIn("Deploying anyway", out.getvalue())
        self.assertIn("the tests fail", out.getvalue())

    def test_force_flag_is_not_passed_on_to_wrangler(self):
        """--force is wr.py's own flag: taken out, wherever it is."""
        self.assertEqual(wr.split_force(["deploy", "--force"]), (["deploy"], True))
        self.assertEqual(wr.split_force(["--force", "deploy", "--dry-run"]), (["deploy", "--dry-run"], True))
        self.assertEqual(wr.split_force(["deploy"]), (["deploy"], False))


if __name__ == "__main__":
    unittest.main()
