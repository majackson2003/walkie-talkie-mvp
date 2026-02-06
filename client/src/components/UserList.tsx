export type UserSummary = {
  id: string;
  nickname: string;
  isSelf?: boolean;
};

type UserListProps = {
  users: UserSummary[];
};

export const UserList = ({ users }: UserListProps) => {
  const sorted = [...users].sort((a, b) => {
    if (a.isSelf && !b.isSelf) return -1;
    if (!a.isSelf && b.isSelf) return 1;
    return a.nickname.localeCompare(b.nickname);
  });

  return (
    <div className="w-full rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-100">
      <div className="flex items-center justify-between">
        <span className="text-slate-300">On Channel</span>
        <span className="text-slate-200">{sorted.length}</span>
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {sorted.length === 0 ? (
          <span className="text-slate-400">No users tracked yet.</span>
        ) : (
          sorted.map((user) => (
            <div key={user.id} className="flex items-center justify-between">
              <span>{user.nickname}</span>
              {user.isSelf ? (
                <span className="rounded-full bg-slate-700/80 px-2 py-0.5 text-xs text-slate-200">
                  You
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
