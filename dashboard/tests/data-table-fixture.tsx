import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DataTable } from "../src/DataTable";
import "../src/styles.css";

const data = Array.from({ length: 15 }, (_, index) => ({
  id: String(index + 1),
  name: `Device ${index + 1}`,
  status: index % 2 ? "paused" : "active",
  count: index === 0 ? null : 15 - index,
}));
function Fixture() {
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  return (
    <main style={{ padding: 20, minWidth: 0 }}>
      <h1>Synthetic table verification</h1>
      <button onClick={() => setLoading(!loading)}>Toggle loading</button>
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          marginTop: 16,
        }}
      >
        <DataTable
          label="Synthetic devices"
          data={data}
          rowKey={(row) => row.id}
          loading={loading}
          defaultSort={{ column: "name", direction: "asc" }}
          pagination={{ page, size: 5, onPage: setPage }}
          columns={[
            {
              id: "name",
              header: "Name",
              value: (row) => row.name,
              filter: {},
              cell: (row) => row.name,
            },
            {
              id: "status",
              header: "Status",
              value: (row) => row.status,
              filter: {
                allLabel: "All statuses",
                options: [
                  { value: "active", label: "Active" },
                  { value: "paused", label: "Paused" },
                ],
              },
              cell: (row) => row.status,
            },
            {
              id: "count",
              header: "Count",
              value: (row) => row.count,
              cell: (row) => row.count ?? "Unavailable",
            },
          ]}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
