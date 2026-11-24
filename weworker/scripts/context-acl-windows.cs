using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal static class ContextAcl {
    private static int Main(string[] paths) {
        if (paths.Length == 1 && paths[0] == "--stdin") {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var result = Verify(line.Split(','));
                Console.WriteLine(result == 0 ? "ok" : "rejected");
                if (result != 0) return result;
            }
            return 0;
        }
        return Verify(paths);
    }

    private static int Verify(string[] paths) {
        try {
            var user = WindowsIdentity.GetCurrent().User.Value;
            foreach (var encoded in paths) {
                var path = Encoding.UTF8.GetString(Convert.FromBase64String(encoded));
                var sections = AccessControlSections.Owner | AccessControlSections.Access;
                FileSystemSecurity acl = Directory.Exists(path)
                    ? (FileSystemSecurity)Directory.GetAccessControl(path, sections)
                    : File.GetAccessControl(path, sections);
                if (acl.GetOwner(typeof(SecurityIdentifier)).Value != user) return 2;
                var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
                if (rules.Count == 0) return 2;
                foreach (FileSystemAccessRule rule in rules) {
                    var sid = rule.IdentityReference.Value;
                    if (rule.AccessControlType == AccessControlType.Allow && sid != user &&
                        sid != "S-1-5-18" && sid != "S-1-5-32-544") return 2;
                }
            }
            return paths.Length == 0 ? 2 : 0;
        } catch { return 2; }
    }
}
