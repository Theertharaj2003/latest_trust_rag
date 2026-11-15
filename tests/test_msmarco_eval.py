from fastapi.testclient import TestClient
from api.main import app
from core.types import Chunk
from core.msmarco_eval import parse_queries, parse_qrels, evaluate_bm25


def test_msmarco_relevance_parsing():
    assert parse_queries('qid\tquery\nq1\twhat is python\n') == {'q1': 'what is python'}
    assert parse_qrels('q1 0 12 1\nq1 0 13 0\nq2 0 14 1') == {'q1': {'12'}, 'q2': {'14'}}


def test_bm25_mrr_coverage_with_missing_gold():
    corpus=[Chunk('d1','a','python is a programming language','MS MARCO passage 12',metadata={'pid':'12'}),
            Chunk('d2','b','a giraffe is an animal','MS MARCO passage 13',metadata={'pid':'13'})]
    result=evaluate_bm25(corpus,{'q1':'python language','q2':'a missing relevant passage'},
                         {'q1':{'12'},'q2':{'999'}},max_queries=10)
    assert result['evaluated_queries']==2
    assert result['mrr_at_10']==0.5
    assert result['coverage_rate']==0.5


def test_dataset_evaluation_endpoints(tmp_path):
    collection=tmp_path/'collection.tsv'
    collection.write_text('12\tpython language tools and interpreters\n13\tzebra savannah mammal\n',encoding='utf-8')
    with TestClient(app) as client:
        loaded=client.post('/api/dataset/load',json={'path':str(collection),'max_records':100})
        assert loaded.status_code==200,loaded.text
        result=client.post('/api/dataset/evaluate?max_queries=10',files={
            'queries_file':('queries.tsv',b'q1\tpython language\n','text/plain'),
            'qrels_file':('qrels.tsv',b'q1 0 12 1\n','text/plain')})
        assert result.status_code==200,result.text
        assert result.json()['mrr_at_10']==1.0
        assert client.get('/api/dataset/evaluation').json()['evaluated_queries']==1
        assert client.post('/api/dataset/unload').json()['loaded'] is False
        assert client.get('/api/dataset/evaluation').json()['available'] is False
