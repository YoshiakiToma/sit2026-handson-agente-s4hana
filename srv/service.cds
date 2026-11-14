@protocol: ['rest']
@path    : '/api'
@requires: 'Agent.Invoke'
service Service {
    action a2aAdapter(task: String) returns String;
}
